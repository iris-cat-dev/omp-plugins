"""Private authenticated snapshots; the live SQLite/WAL files are never opened by SQLite.

WCDB encrypted-page/WAL layout follows wechatauto-replica db.py.
Changed implementation: double-read stable copies, page HMACs, SQLite WAL
checksum chain, transaction commit boundaries, private ownership and bounds.
"""
import hashlib
import os
from pathlib import Path
import shutil
import sqlite3
import struct
import tempfile
from dataclasses import dataclass
from uuid import uuid4

from .crypto import PAGE_SIZE, RESERVE_SIZE, SQLITE_HEADER, PageCipher
from .errors import ReaderError

MAX_DATABASE_BYTES = 8 * 1024 * 1024 * 1024
MAX_WAL_BYTES = 1024 * 1024 * 1024
BLOCK_SIZE = 1024 * 1024


def signature(path: Path):
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


def checksum(data: bytes, state=(0, 0), little=True):
    if len(data) % 8:
        raise ReaderError("INVALID_WAL")
    a, b = state
    for x, y in struct.iter_unpack("<II" if little else ">II", data):
        a = (a + x + b) & 0xFFFFFFFF
        b = (b + y + a) & 0xFFFFFFFF
    return a, b


def apply_wal(destination: Path, wal: Path, cipher: PageCipher):
    """Apply only the prefix ending at the last authenticated commit.

    SQLite/WCDB may preallocate old-generation or zero-filled tail frames.
    Such a tail terminates the active generation; a current-generation frame
    with invalid checksum or HMAC is corruption, not a successful empty read.
    """
    size = wal.stat().st_size
    if size == 0:
        return 0, 0
    if size < 32 or size > MAX_WAL_BYTES:
        raise ReaderError("INVALID_WAL")
    with wal.open("rb") as source:
        header = source.read(32)
        magic, version, page_size = struct.unpack(">III", header[:12])
        if magic not in (0x377F0682, 0x377F0683) or version != 3007000 or page_size != PAGE_SIZE:
            raise ReaderError("INVALID_WAL")
        little = magic == 0x377F0682
        state = checksum(header[:24], little=little)
        if state != struct.unpack(">II", header[24:32]):
            raise ReaderError("INVALID_WAL")
        frames = 0
        committed = 0
        final_pages = 0
        while source.tell() < size:
            frame_header = source.read(24)
            if len(frame_header) < 24:
                raise ReaderError("SNAPSHOT_CHANGED")
            if frame_header[8:16] != header[16:24]:
                break
            page = source.read(PAGE_SIZE)
            if len(page) != PAGE_SIZE:
                raise ReaderError("SNAPSHOT_CHANGED")
            number, db_size = struct.unpack(">II", frame_header[:8])
            if number == 0 or number * PAGE_SIZE > MAX_DATABASE_BYTES or db_size * PAGE_SIZE > MAX_DATABASE_BYTES:
                raise ReaderError("INVALID_WAL")
            state = checksum(frame_header[:8] + page, state, little)
            if state != struct.unpack(">II", frame_header[16:24]) or not cipher.authenticated(page, number):
                raise ReaderError("INVALID_WAL")
            frames += 1
            if db_size:
                committed = frames
                final_pages = db_size
        if not committed:
            return 0, frames
        source.seek(32)
        with destination.open("r+b") as target:
            for _ in range(committed):
                frame_header = source.read(24)
                page = source.read(PAGE_SIZE)
                number = struct.unpack(">I", frame_header[:4])[0]
                # A commit can shrink the database; obsolete pages are irrelevant.
                if number <= final_pages:
                    target.seek((number - 1) * PAGE_SIZE)
                    target.write(cipher.decrypt(page, number))
            target.truncate(final_pages * PAGE_SIZE)
            target.seek(28)
            target.write(struct.pack(">I", final_pages))
    return committed, frames - committed


@dataclass
class Snapshot:
    signature: tuple
    path: Path
    committed_frames: int
    ignored_frames: int

@dataclass
class BaseSnapshot:
    signature: tuple
    path: Path
    cipher: PageCipher



class _SnapshotConnection(sqlite3.Connection):
    """Keep a published snapshot generation alive until its last reader closes."""
    def close(self):
        store = getattr(self, "_snapshot_store", None)
        super().close()
        if store is not None:
            self._snapshot_store = None
            store._release(self)


class SnapshotStore:
    def __init__(self, key: bytes, work_root=None):
        self.key = key
        root = Path(work_root) if work_root is not None else None
        if root is not None:
            root.mkdir(parents=True, exist_ok=True)
        self.directory = Path(tempfile.mkdtemp(prefix="wechat-read-", dir=root))
        if os.name != "nt":
            self.directory.chmod(0o700)
        self.entries = {}
        self.bases = {}
        self.base_decryptions = 0
        self.reused = 0
        self.built = 0
        self._connections = {}

    @staticmethod
    def _copy(source: Path, destination: Path, cap: int):
        digest = hashlib.sha256()
        total = 0
        with source.open("rb") as stream, destination.open("wb") as target:
            while True:
                chunk = stream.read(BLOCK_SIZE)
                if not chunk:
                    break
                total += len(chunk)
                if total > cap:
                    raise ReaderError("INVALID_DATABASE")
                digest.update(chunk)
                target.write(chunk)
        return digest.digest()

    @staticmethod
    def _digest(source: Path, cap: int):
        digest = hashlib.sha256()
        total = 0
        with source.open("rb") as stream:
            while True:
                chunk = stream.read(BLOCK_SIZE)
                if not chunk:
                    break
                total += len(chunk)
                if total > cap:
                    raise ReaderError("INVALID_DATABASE")
                digest.update(chunk)
        return digest.digest()

    def open(self, source: Path):
        wal = Path(str(source) + "-wal")
        current = (signature(source), signature(wal))
        if current[0] is None:
            raise ReaderError("DATABASE_NOT_FOUND")
        entry = self.entries.get(source)
        if entry and entry.signature == current:
            self.reused += 1
            return self._lease(entry.path)
        token = hashlib.sha256(str(source).encode("utf-8")).hexdigest()
        encrypted = self.directory / (token + ".input")
        wal_copy = self.directory / (token + ".wal-input")
        pending = self.directory / (token + ".pending")
        ready = self.directory / (token + "." + uuid4().hex + ".db")
        base_pending = self.directory / (token + ".base-pending")
        base_ready = self.directory / (token + ".base")
        try:
            for attempt in range(3):
                before = (signature(source), signature(wal))
                if before[0] is None:
                    raise ReaderError("DATABASE_NOT_FOUND")
                if before[0][2] == 0 or before[0][2] % PAGE_SIZE or before[0][2] > MAX_DATABASE_BYTES:
                    raise ReaderError("INVALID_DATABASE")
                base = self.bases.get(source)
                reuse_base = base is not None and base.signature == before[0]
                try:
                    db_hash = None if reuse_base else self._copy(source, encrypted, MAX_DATABASE_BYTES)
                    wal_hash = self._copy(wal, wal_copy, MAX_WAL_BYTES) if before[1] else None
                    if before != (signature(source), signature(wal)):
                        continue
                    if db_hash is not None and db_hash != self._digest(source, MAX_DATABASE_BYTES):
                        continue
                    if wal_hash is not None and wal_hash != self._digest(wal, MAX_WAL_BYTES):
                        continue
                    if before != (signature(source), signature(wal)):
                        continue
                except FileNotFoundError:
                    continue
                if reuse_base:
                    cipher = base.cipher
                    shutil.copyfile(base.path, pending)
                else:
                    with encrypted.open("rb") as incoming, base_pending.open("wb") as output:
                        first = incoming.read(PAGE_SIZE)
                        cipher = PageCipher.from_input(self.key, first)
                        output.write(cipher.decrypt(first, 1))
                        number = 2
                        while True:
                            page = incoming.read(PAGE_SIZE)
                            if not page:
                                break
                            output.write(cipher.decrypt(page, number))
                            number += 1
                    shutil.copyfile(base_pending, pending)
                committed, ignored = apply_wal(pending, wal_copy, cipher) if wal_hash is not None else (0, 0)
                self._validate(pending)
                # Do not publish stale data if a checkpoint occurred during decrypt.
                if before != (signature(source), signature(wal)):
                    continue
                pending.replace(ready)
                if not reuse_base:
                    base_pending.replace(base_ready)
                    self.bases[source] = BaseSnapshot(before[0], base_ready, cipher)
                    self.base_decryptions += 1
                previous = self.entries.get(source)
                self.entries[source] = Snapshot(before, ready, committed, ignored)
                self.built += 1
                if previous is not None:
                    self._discard(previous.path)
                return self._lease(ready)
            raise ReaderError("SNAPSHOT_CHANGED")
        finally:
            for path in (encrypted, wal_copy, pending, base_pending):
                path.unlink(missing_ok=True)
            if not any(entry.path == ready for entry in self.entries.values()):
                ready.unlink(missing_ok=True)

    @staticmethod
    def _connect(path: Path):
        connection = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True, factory=_SnapshotConnection)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA query_only=ON")
            connection.execute("PRAGMA trusted_schema=OFF")
            connection.text_factory = lambda value: value.decode("utf-8")
            return connection
        except BaseException:
            connection.close()
            raise

    def _lease(self, path):
        connection = self._connect(path)
        connection._snapshot_store = self
        self._connections[connection] = path
        return connection

    def _discard(self, path):
        if path not in self._connections.values() and not any(entry.path == path for entry in self.entries.values()):
            path.unlink(missing_ok=True)

    def _release(self, connection):
        path = self._connections.pop(connection, None)
        if path is not None:
            self._discard(path)

    def _validate(self, path: Path):
        with path.open("rb") as source:
            header = source.read(100)
        if (header[:16] != SQLITE_HEADER or header[16:18] != b"\x10\x00"
                or header[20] != RESERVE_SIZE or header[18] not in (1, 2) or header[19] not in (1, 2)):
            raise ReaderError("INVALID_DATABASE")
        connection = self._connect(path)
        try:
            if [row[0] for row in connection.execute("PRAGMA quick_check")] != ["ok"]:
                raise ReaderError("INVALID_DATABASE")
        finally:
            connection.close()

    def close(self):
        for connection in list(self._connections):
            connection.close()
        shutil.rmtree(self.directory)
        self.entries.clear()
        self.bases.clear()
        self.key = b""
