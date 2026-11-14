"""Explicitly enabled, account-bound NDJSON text receiver. No sending or GUI.

Only start/poll/ack/members/close are exposed. Cursors move after the consumer
has durably journaled the exact staged batch and calls ack. First use baselines
existing tables without returning history. SQLite fixtures require --fixture;
that explicit mode never opens or inspects a WeChat process.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack, closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import time
import traceback
import uuid
import unicodedata
from xml.etree import ElementTree

from readonly.errors import ReaderError
from readonly.process import IdentityError, SelectedProcess
from readonly.snapshot import SnapshotStore

MAX_FRAME = 1024 * 1024
MAX_CONTENT = 128 * 1024
MAX_BATCH_BYTES = 700 * 1024
MAX_ROWS = 100
ACCOUNT = re.compile(r'wxid_[A-Za-z0-9_-]{1,120}\Z')
TARGET = re.compile(r'(?:wxid_[A-Za-z0-9_-]{1,120}|[0-9]{1,100}@chatroom)\Z')


class ReceiverError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(code, message):
    raise ReceiverError(code, message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail('INVALID_REQUEST', 'JSON 对象含重复字段。')
        result[key] = value
    return result


def parse_json(value):
    return json.loads(value, object_pairs_hook=unique_object,
                      parse_constant=lambda value: fail('INVALID_REQUEST', 'JSON 数值无效。'))


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def identifier(value, *, account=False):
    if not isinstance(value, str) or not (ACCOUNT if account else TARGET).fullmatch(value):
        fail('INVALID_CONFIGURATION', '需要稳定的账号或会话 ID。')
    return value


def member_identifier(value):
    return (isinstance(value, str) and bool(value.strip()) and value != 'notify@all'
            and not any(unicodedata.category(char) in {'Cc', 'Cf', 'Cs'} for char in value)
            and len(value.encode('utf-8')) <= 256)


def public_member_name(value, member_id):
    if value is not None and (not isinstance(value, str) or len(value.encode('utf-8')) > 4096):
        fail('INVALID_MEMBER_MAPPING', '当前成员公开名称无法完整解析。')
    return value if value and value.strip() and value != member_id else '群友'


def integer(value, *, positive=False):
    if type(value) is not int or not (1 if positive else 0) <= value <= 9007199254740991:
        fail('INVALID_CONFIGURATION', '整数参数无效。')
    return value


def quote(value):
    return '"' + value.replace('"', '""') + '"'


def table_for(session_id):
    return 'Msg_' + hashlib.md5(session_id.encode('utf-8')).hexdigest()


def content(value):
    if value is None:
        return ''
    if isinstance(value, bytes):
        if len(value) > MAX_CONTENT:
            fail('CONTENT_DECODE_FAILED', '消息正文超出读取边界。')
        if value.startswith(b'\x28\xb5\x2f\xfd'):
            try:
                import zstandard
            except ImportError:
                raise ReaderError('DEPENDENCY_MISSING') from None
            try:
                size = zstandard.frame_content_size(value)
                if size != zstandard.CONTENTSIZE_UNKNOWN and size > MAX_CONTENT:
                    fail('CONTENT_DECODE_FAILED', '压缩消息声明的正文超出读取边界。')
                value = zstandard.ZstdDecompressor().decompress(value, max_output_size=MAX_CONTENT, allow_extra_data=False)
            except zstandard.ZstdError:
                fail('CONTENT_DECODE_FAILED', '压缩消息无法完整解码。')
        try:
            value = value.decode('utf-8')
        except UnicodeError:
            fail('CONTENT_DECODE_FAILED', '消息不是完整 UTF-8。')
    if not isinstance(value, str) or len(value.encode('utf-8')) > MAX_CONTENT or '\0' in value:
        fail('CONTENT_DECODE_FAILED', '消息正文类型或长度无效。')
    return value


def mentions(value):
    if value in (None, '', b''):
        return []
    source = content(value)
    if '<!DOCTYPE' in source.upper() or '<!ENTITY' in source.upper():
        fail('INVALID_SOURCE', '消息来源含实体声明。')
    try:
        root = ElementTree.fromstring(source)
    except ElementTree.ParseError:
        fail('INVALID_SOURCE', '消息来源 XML 无法完整解析。')
    nodes = list(root.iter('atuserlist'))
    if len(nodes) > 1 or (nodes and len(nodes[0])):
        fail('INVALID_SOURCE', '消息来源的真实 @ 列表存在歧义。')
    result = []
    for value in ((nodes[0].text or '').split(',') if nodes else []):
        value = value.strip()
        if not value:
            continue
        if value != 'notify@all' and not member_identifier(value):
            fail('INVALID_SOURCE', '真实 @ 列表含无法核验的成员 ID。')
        if value not in result:
            result.append(value)
    return result


def uint64(value):
    if isinstance(value, str) and re.fullmatch(r'[0-9]{1,20}', value):
        number = int(value)
    elif type(value) is int and -(1 << 63) <= value < (1 << 64):
        number = value if value >= 0 else value + (1 << 64)
    else:
        fail('INVALID_MESSAGE_ID', '平台消息 ID 无效。')
    if not 0 < number < (1 << 64):
        fail('INVALID_MESSAGE_ID', '平台消息 ID 尚未形成。')
    return str(number)


def columns(connection, table, required):
    actual = {row[1] for row in connection.execute('PRAGMA table_info(' + quote(table) + ')')}
    if not required <= actual:
        fail('UNSUPPORTED_SCHEMA', '数据库缺少接收所需的已核验字段。')
    return actual


def sender_for(connection, sender_id):
    if type(sender_id) is not int or sender_id <= 0:
        fail('INVALID_SENDER_MAPPING', '文本消息没有可核验的真实发送者。')
    tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
              if row[0] == 'SenderName2Id' or re.fullmatch(r'Name2Id(?:_[0-9]+)?', row[0])]
    mapped = []
    for table in tables:
        columns(connection, table, {'user_name'})
        rows = connection.execute('SELECT user_name FROM ' + quote(table) + ' WHERE rowid=?', (sender_id,)).fetchall()
        if rows:
            if len(rows) != 1 or not member_identifier(rows[0][0]):
                fail('INVALID_SENDER_MAPPING', '真实发送者目录损坏。')
            mapped.append(rows[0][0])
    if len(set(mapped)) > 1:
        fail('INVALID_SENDER_MAPPING', '真实发送者目录存在歧义。')
    return mapped[0] if mapped else None


class FixtureIdentity:
    """Controlled SQLite-only proof, reachable only through explicit --fixture."""
    def __init__(self, binding, root):
        self.binding, self.path = binding, root / 'fixture-identity.sqlite'

    def verify(self):
        import psutil
        try:
            process = psutil.Process(self.binding['pid'])
            if not process.is_running() or round(process.create_time() * 1000) != self.binding['createdAtMs']:
                raise IdentityError()
            with closing(sqlite3.connect(self.path.as_uri() + '?mode=ro', uri=True)) as connection:
                rows = connection.execute('SELECT account_id,pid,created_at_ms FROM receiver_fixture_identity').fetchall()
            if rows != [(self.binding['accountId'], self.binding['pid'], self.binding['createdAtMs'])]:
                raise IdentityError()
        except (psutil.Error, sqlite3.Error, OSError):
            raise IdentityError() from None

    def close(self):
        pass


class DatabaseSource:
    def __init__(self, binding, *, fixture=False):
        contacts = binding.get('contactDatabaseFiles')
        if not isinstance(contacts, list) or any(not isinstance(value, str) for value in contacts):
            fail('BINDING_INCOMPLETE', '绑定需要 contactDatabaseFiles 数据库路径列表。')
        contacts = [value for value in contacts if Path(value).name == 'contact.db']
        if len(contacts) != 1:
            fail('BINDING_INCOMPLETE', '绑定需要唯一的 contact.db 联系人数据库路径。')
        original = Path(contacts[0])
        if not original.is_absolute():
            fail('BINDING_INCOMPLETE', '绑定数据库必须使用绝对路径。')
        contact = original.resolve(strict=True)
        self.root = contact.parent.parent
        if contact.name != 'contact.db' or contact.parent.name != 'contact' or self.root.name != 'db_storage':
            fail('BINDING_INCOMPLETE', '绑定联系人路径不是明确的 db_storage/contact/contact.db。')
        self.contact = contact
        self.fixture = fixture
        if fixture and binding.get('fixture') is not True:
            fail('INVALID_CONFIGURATION', '夹具模式需要显式 fixture 绑定。')
        if not fixture and binding.get('fixture'):
            fail('INVALID_CONFIGURATION', '生产接收器不接受夹具身份。')
        self.identity = FixtureIdentity(binding, self.root) if fixture else SelectedProcess(binding['accountId'], binding['pid'], binding['createdAtMs'])
        self.stores = {}
        self.keys = {}
        self.temporary = None
        try:
            self.temporary = tempfile.TemporaryDirectory(prefix='omp-receiver-')
            self.verify()
        except BaseException:
            self.close()
            raise

    def verify(self):
        self.identity.verify()
        if self.contact.resolve(strict=True) != self.contact or self.root.resolve(strict=True) != self.root:
            raise IdentityError()

    def shards(self):
        self.verify()
        directory = self.root / 'message'
        files = sorted(file for file in directory.glob('message_*.db') if re.fullmatch(r'message_[0-9]+\.db', file.name))
        if not files:
            fail('DATABASE_NOT_FOUND', '绑定账号没有可核验的消息分片。')
        for file in files:
            self._path(file)
        return files

    def _path(self, path):
        if not path.resolve(strict=True).is_relative_to(self.root) or path.resolve(strict=True) != path:
            raise IdentityError()

    def open(self, path):
        self.verify()
        self._path(path)
        if self.fixture:
            connection = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
            try:
                connection.row_factory = sqlite3.Row
                connection.execute('PRAGMA query_only=ON')
                connection.execute('PRAGMA trusted_schema=OFF')
                return connection
            except BaseException:
                connection.close()
                raise
        if path not in self.stores:
            # Only selected-account files; keys are authenticated and live only
            # in this process. No sibling application or persisted key cache.
            if path not in self.keys:
                candidates = [*self.shards(), self.contact]
                resource = self.root / 'message' / 'message_resource.db'
                if resource.is_file():
                    candidates.append(resource)
                for candidate in candidates:
                    self._path(candidate)
                self.keys.update(self.identity.keys([candidate for candidate in candidates if candidate not in self.stores]))
            key = self.keys.pop(path, None)
            if key is None:
                fail('KEY_UNAVAILABLE', '该分片缺少通过认证的只读密钥。')
            self.stores[path] = SnapshotStore(key, self.temporary.name)
        connection = self.stores[path].open(path)
        try:
            self.verify()
            return connection
        except BaseException:
            connection.close()
            raise

    def close(self):
        with ExitStack() as stack:
            if self.temporary is not None:
                stack.callback(self.temporary.cleanup)
            stack.callback(self.identity.close)
            for store in self.stores.values():
                stack.callback(store.close)
            self.stores.clear()
            self.keys.clear()


class StateLock:
    def __init__(self, directory):
        self.file = (directory / 'receiver.lock').open('a+b')
        try:
            self.file.seek(0, os.SEEK_END)
            if not self.file.tell():
                self.file.write(b'0')
                self.file.flush()
            self.file.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            fail('STATE_BUSY', '接收状态目录已由另一接收器持有。')

    def close(self):
        self.file.close()


class Receiver:
    def __init__(self, *, account_id, pid, created_at_ms, binding_path, state_dir, allowed_targets, allow_read=False, fixture=False):
        self.account_id = identifier(account_id, account=True)
        self.pid, self.created_at_ms = integer(pid, positive=True), integer(created_at_ms, positive=True)
        if type(allow_read) is not bool or type(fixture) is not bool:
            fail('INVALID_CONFIGURATION', '读取开关必须是布尔值。')
        if not isinstance(allowed_targets, list) or not allowed_targets or len(allowed_targets) > 256:
            fail('INVALID_CONFIGURATION', '必须明确配置有限的允许会话。')
        self.targets = tuple(identifier(value) for value in allowed_targets)
        if len(set(self.targets)) != len(self.targets) or account_id in self.targets:
            fail('INVALID_CONFIGURATION', '允许会话不能重复或指向账号自身。')
        self.binding_path, self.state_dir = Path(binding_path), Path(state_dir)
        if not self.binding_path.is_absolute() or not self.state_dir.is_absolute():
            fail('INVALID_CONFIGURATION', '绑定和状态目录必须是绝对路径。')
        self.allow_read, self.fixture = allow_read, fixture
        self.source = self.db = self.lock = None
        self.started = self.closed = False

    def _identity(self):
        binding = parse_json(self.binding_path.read_text('utf-8'))
        if (not isinstance(binding, dict) or binding.get('accountId') != self.account_id
                or binding.get('pid') != self.pid or binding.get('createdAtMs') != self.created_at_ms):
            raise IdentityError()
        if self.source:
            if binding != self.binding:
                raise IdentityError()
            self.source.verify()
        return binding

    def _ready(self):
        if not self.started or self.closed:
            fail('RECEIVER_CLOSED', '接收器未启动或已经关闭。')
        self._identity()

    def start(self):
        if self.closed:
            fail('RECEIVER_CLOSED', '接收器已经关闭。')
        if not self.allow_read:
            fail('READ_DISABLED', '只读接收默认关闭；需要明确 allowRead 授权。')
        if self.started:
            self._ready()
            return self._status([])
        self.binding = self._identity()
        try:
            self.source = DatabaseSource(self.binding, fixture=self.fixture)
            self.state_dir.mkdir(parents=True, exist_ok=True)
            if os.name != 'nt':
                self.state_dir.chmod(0o700)
            self.lock = StateLock(self.state_dir)
            self.db = sqlite3.connect(self.state_dir / 'receiver.sqlite')
            self.db.execute('PRAGMA synchronous=FULL')
            self.db.executescript('''
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS cursors (source TEXT NOT NULL,session TEXT NOT NULL,local_id INTEGER,
                    PRIMARY KEY(source,session));
                CREATE TABLE IF NOT EXISTS delivered (session TEXT NOT NULL,message_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
                    PRIMARY KEY(session,message_id));
                CREATE TABLE IF NOT EXISTS staged (id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
            ''')
            with self.db:
                expected = {'accountId': self.account_id, 'databaseRoot': str(self.source.root), 'version': '1'}
                for key, value in expected.items():
                    row = self.db.execute('SELECT value FROM metadata WHERE key=?', (key,)).fetchone()
                    if row and row[0] != value:
                        fail('STATE_BINDING_MISMATCH', '该游标状态属于其他账号、目录或版本。')
                    self.db.execute('INSERT OR IGNORE INTO metadata VALUES (?,?)', (key, value))
                shards = self.source.shards()
                errors = self._baseline(shards, starting=True)
            self.source.verify()
            self.started = True
            return self._status(errors)
        except BaseException:
            self.close()
            raise

    def _status(self, errors):
        row = self.db.execute('SELECT payload FROM staged WHERE id=1').fetchone()
        return {'ready': True, 'readAllowed': True, 'accountId': self.account_id,
                'pid': self.pid, 'createdAtMs': self.created_at_ms, 'errors': errors,
                'pendingBatchId': parse_json(row[0])['batchId'] if row else None}

    def _key(self, file):
        return str(file.relative_to(self.source.root)).replace('\\', '/')

    def _baseline(self, shards, *, starting=False):
        errors = {}
        known = {row[0] for row in self.db.execute('SELECT DISTINCT source FROM cursors')}
        for file in shards:
            key = self._key(file)
            for session in self.targets:
                row = self.db.execute('SELECT local_id FROM cursors WHERE source=? AND session=?', (key, session)).fetchone()
                if row is not None and row[0] is not None:
                    continue
                try:
                    with closing(self.source.open(file)) as connection:
                        table = table_for(session)
                        names = {item[0] for item in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                        if table in names:
                            columns(connection, table, {'local_id'})
                            maximum = connection.execute('SELECT MAX(local_id) FROM ' + quote(table)).fetchone()[0] or 0
                            integer(maximum)
                        else:
                            maximum = 0
                    # New shards while already running are new input. New target
                    # registration and a failed initial baseline never replay.
                    baseline = maximum if starting or row is not None or key in known else 0
                    self.db.execute('INSERT OR REPLACE INTO cursors VALUES (?,?,?)', (key, session, baseline))
                except (ReceiverError, ReaderError, sqlite3.Error, OSError) as error:
                    self.db.execute('INSERT OR IGNORE INTO cursors VALUES (?,?,NULL)', (key, session))
                    errors.setdefault(session, self._error(error, session))
        return list(errors.values())

    @staticmethod
    def _error(error, session):
        return {'sessionId': session, 'code': getattr(error, 'code', 'DATABASE_READ_FAILED'),
                'message': str(error) if isinstance(error, (ReceiverError, ReaderError)) else '该会话数据库当前不可完整读取。'}

    def _event(self, connection, resource, session, row):
        sender = sender_for(connection, row['real_sender_id'])
        if sender is None:
            global_connection = resource()
            sender = sender_for(global_connection, row['real_sender_id']) if global_connection else None
        if not sender:
            fail('INVALID_SENDER_MAPPING', '文本消息的真实发送者没有目录映射。')
        if sender == self.account_id:
            return None
        if not session.endswith('@chatroom') and sender != session:
            fail('INVALID_SENDER_MAPPING', '私聊发送者与获准会话不一致。')
        body = content(row['message_content'])
        compressed = content(row['compress_content']) if 'compress_content' in row.keys() and row['compress_content'] else ''
        if body and compressed and body != compressed:
            fail('CONTENT_DECODE_FAILED', '正文与压缩正文存在歧义。')
        body = body or compressed
        if not body:
            fail('CONTENT_DECODE_FAILED', '入站文本消息正文为空。')
        timestamp = integer(row['create_time'])
        return {'accountId': self.account_id, 'scope': 'group' if session.endswith('@chatroom') else 'private',
                'sessionId': session, 'senderId': sender,
                'senderName': '群友' if session.endswith('@chatroom') else '联系人',
                'messageId': uint64(row['server_id']), 'createdAtMs': integer(timestamp * 1000),
                'text': body, 'mentions': mentions(row['source'] if 'source' in row.keys() else None)}

    def poll(self):
        self._ready()
        row = self.db.execute('SELECT payload FROM staged WHERE id=1').fetchone()
        if row:
            staged = parse_json(row[0])
            batch_targets = {advance[1] for advance in staged['advances']} | {error['sessionId'] for error in staged['errors'] if 'sessionId' in error}
            if not batch_targets <= set(self.targets):
                fail('PENDING_TARGET_CHANGED', '未确认批次包含已移出的会话，必须先按原绑定完成持久入站。')
            for event in staged['events']:
                event['senderName'] = '群友' if event['scope'] == 'group' else '联系人'
            return {key: staged[key] for key in ('batchId', 'events', 'errors')}
        shards = self.source.shards()
        with self.db:
            errors = self._baseline(shards)
        blocked = {error['sessionId'] for error in errors}
        events, advances, fingerprints = [], [], []
        used_bytes = 0
        next_row = self.db.execute("SELECT value FROM metadata WHERE key='nextSession'").fetchone()
        offset = int(next_row[0]) % len(self.targets) if next_row else 0
        targets = self.targets[offset:] + self.targets[:offset]
        for session in targets:
            if session in blocked or used_bytes > MAX_BATCH_BYTES - MAX_CONTENT - 4096:
                continue
            peer_events, peer_advances, peer_fingerprints = [], [], {}
            peer_bytes = 0
            try:
                resource_path = self.source.root / 'message' / 'message_resource.db'
                resource = []
                def resource_connection():
                    if not resource:
                        resource.append(self.source.open(resource_path) if resource_path.is_file() else None)
                    return resource[0]
                try:
                    for file in shards:
                        cursor = self.db.execute('SELECT local_id FROM cursors WHERE source=? AND session=?', (self._key(file), session)).fetchone()[0]
                        with closing(self.source.open(file)) as connection:
                            table = table_for(session)
                            names = {item[0] for item in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                            if table not in names:
                                continue
                            required = {'local_id', 'local_type', 'real_sender_id', 'create_time', 'message_content', 'server_id'}
                            actual = columns(connection, table, required)
                            selected = sorted(required) + [name for name in ('compress_content', 'source') if name in actual]
                            rows = connection.execute('SELECT ' + ','.join(map(quote, selected)) + ' FROM ' + quote(table)
                                + ' WHERE local_id>? AND (local_type & 4294967295)=1 ORDER BY local_id LIMIT ?', (cursor, MAX_ROWS)).fetchall()
                            high = cursor
                            for row in rows:
                                local_id = integer(row['local_id'], positive=True)
                                event = self._event(connection, resource_connection, session, row)
                                if event is not None:
                                    fingerprint = hashlib.sha256(encode({key: value for key, value in event.items() if key != 'senderName'}).encode('utf-8')).hexdigest()
                                    delivered = self.db.execute('SELECT fingerprint FROM delivered WHERE session=? AND message_id=?', (session, event['messageId'])).fetchone()
                                    prior = delivered[0] if delivered else peer_fingerprints.get(event['messageId'])
                                    if prior is not None and prior != fingerprint:
                                        fail('DUPLICATE_CONFLICT', '同一平台消息 ID 存在矛盾的入站记录。')
                                    if prior is None:
                                        size = len(encode(event).encode('utf-8'))
                                        if used_bytes + peer_bytes + size > MAX_BATCH_BYTES:
                                            break
                                        peer_events.append(event)
                                        peer_bytes += size
                                        peer_fingerprints[event['messageId']] = fingerprint
                                high = local_id
                            else:
                                if len(rows) < MAX_ROWS:
                                    high = connection.execute('SELECT MAX(local_id) FROM ' + quote(table)).fetchone()[0] or 0
                                    integer(high)
                            if high < cursor:
                                fail('CURSOR_REGRESSION', '消息表已回退，不能自动重置游标。')
                            if high > cursor:
                                peer_advances.append([self._key(file), session, high])
                finally:
                    if resource and resource[0]:
                        resource[0].close()
                self.source.verify()
                events.extend(peer_events)
                advances.extend(peer_advances)
                fingerprints.extend([session, message_id, value] for message_id, value in peer_fingerprints.items())
                used_bytes += peer_bytes
            except (ReceiverError, ReaderError, sqlite3.Error, OSError) as error:
                errors.append(self._error(error, session))
        self._identity()
        if not advances:
            return {'batchId': None, 'events': [], 'errors': errors}
        staged = {'batchId': uuid.uuid4().hex, 'events': events, 'errors': errors, 'advances': advances, 'fingerprints': fingerprints}
        with self.db:
            self.db.execute('INSERT INTO staged VALUES (1,?)', (encode(staged),))
            self.db.execute("INSERT OR REPLACE INTO metadata VALUES ('nextSession',?)", (str((offset + 1) % len(self.targets)),))
        return {key: staged[key] for key in ('batchId', 'events', 'errors')}

    def ack(self, batch_id):
        self._ready()
        if not isinstance(batch_id, str) or not re.fullmatch(r'[0-9a-f]{32}', batch_id):
            fail('INVALID_BATCH', '需要准确的待确认批次 ID。')
        with self.db:
            row = self.db.execute('SELECT payload FROM staged WHERE id=1').fetchone()
            if not row or parse_json(row[0])['batchId'] != batch_id:
                fail('INVALID_BATCH', '批次不存在或不是当前待确认批次。')
            staged = parse_json(row[0])
            for source, session, local_id in staged['advances']:
                self.db.execute('UPDATE cursors SET local_id=? WHERE source=? AND session=?', (local_id, source, session))
            self.db.executemany('INSERT INTO delivered VALUES (?,?,?)', staged['fingerprints'])
            self.db.execute('DELETE FROM staged WHERE id=1')
        return {'acked': True, 'batchId': batch_id}

    def members(self, group_id):
        self._ready()
        if group_id not in self.targets or not group_id.endswith('@chatroom'):
            fail('TARGET_NOT_ALLOWED', '只能读取已登记允许群的真实成员。')
        with closing(self.source.open(self.source.contact)) as connection:
            columns(connection, 'contact', {'id', 'username', 'nick_name'})
            columns(connection, 'chat_room', {'id', 'username'})
            columns(connection, 'chatroom_member', {'room_id', 'member_id'})
            rooms = connection.execute('SELECT id FROM chat_room WHERE username=?', (group_id,)).fetchall()
            if len(rooms) != 1:
                fail('MEMBERS_UNAVAILABLE', '没有唯一可核验的当前群成员目录。')
            rows = connection.execute('SELECT c.username,c.nick_name FROM chatroom_member m LEFT JOIN contact c ON c.id=m.member_id WHERE m.room_id=?', (rooms[0][0],)).fetchall()
            result, seen = [], set()
            for row in rows:
                member_id = row['username']
                if not member_identifier(member_id) or member_id in seen:
                    fail('INVALID_MEMBER_MAPPING', '当前群成员目录损坏或存在重复映射。')
                seen.add(member_id)
                result.append({'userId': member_id, 'name': public_member_name(row['nick_name'], member_id)})
            if not result or self.account_id not in seen:
                fail('MEMBERS_UNAVAILABLE', '当前成员目录不完整或本账号已不在群内。')
        self._identity()
        return {'groupId': group_id, 'members': sorted(result, key=lambda item: item['userId'])}

    def close(self):
        if self.closed:
            return {'closed': True}
        self.closed = True
        try:
            if self.source:
                self.source.close()
        finally:
            try:
                if self.db:
                    self.db.close()
            finally:
                if self.lock:
                    self.lock.close()
        return {'closed': True}


def serve(receiver, input_stream, output_stream):
    try:
        while True:
            line = input_stream.readline(MAX_FRAME + 1)
            if not line:
                break
            request_id = None
            try:
                if len(line) > MAX_FRAME or not line.endswith(b'\n'):
                    fail('INVALID_REQUEST', 'NDJSON 请求未完整终止或超出帧边界。')
                request = parse_json(line.decode('utf-8'))
                if (not isinstance(request, dict) or set(request) != {'id', 'method', 'params'}
                        or not isinstance(request['id'], str) or not 0 < len(request['id']) <= 200
                        or not isinstance(request['params'], dict) or not isinstance(request['method'], str)):
                    fail('INVALID_REQUEST', '请求需要唯一 id、method 和 params。')
                request_id, method, params = request['id'], request['method'], request['params']
                expected = {'start': set(), 'poll': set(), 'ack': {'batchId'}, 'members': {'groupId'}, 'close': set()}
                if method not in expected or set(params) != expected[method]:
                    fail('INVALID_REQUEST', '不支持的方法或参数。')
                if method == 'ack':
                    result = receiver.ack(params['batchId'])
                elif method == 'members':
                    result = receiver.members(params['groupId'])
                else:
                    result = getattr(receiver, method)()
                response = {'id': request_id, 'result': result}
            except (ReceiverError, ReaderError, IdentityError) as error:
                response = {'id': request_id, 'error': {'code': error.code, 'message': str(error)}}
                if isinstance(error, IdentityError):
                    frames = []
                    failure = error
                    for _ in range(3):
                        if failure is None:
                            break
                        frames.extend({'file': Path(item.filename).name, 'function': item.name, 'line': item.lineno}
                                      for item in traceback.extract_tb(failure.__traceback__)[-6:])
                        failure = failure.__cause__
                    diagnostic = {'code': error.code, 'method': method, 'atMs': time.time_ns() // 1_000_000, 'frames': frames}
                    try:
                        temporary = receiver.state_dir / 'last-identity-failure.json.tmp'
                        temporary.write_text(encode(diagnostic) + '\n', encoding='utf-8')
                        temporary.replace(receiver.state_dir / 'last-identity-failure.json')
                    except OSError:
                        sys.stderr.write('IDENTITY_DIAGNOSTIC_WRITE_FAILED\n')
            except (ValueError, TypeError, KeyError, UnicodeError, OSError, sqlite3.Error):
                response = {'id': request_id, 'error': {'code': 'RECEIVER_FAILED', 'message': '读取或持久游标失败；未确认的消息不会自动跳过。'}}
            payload = (encode(response) + '\n').encode('utf-8')
            if len(payload) > MAX_FRAME:
                fail('FRAME_TOO_LARGE', '响应超过 NDJSON 帧边界。')
            output_stream.write(payload)
            output_stream.flush()
            if request_id is None or (request.get('method') == 'close'):
                break
    finally:
        receiver.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--account-id', required=True)
    parser.add_argument('--pid', required=True, type=int)
    parser.add_argument('--created-at-ms', required=True, type=int)
    parser.add_argument('--binding-path', required=True)
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--allowed-target', action='append', required=True)
    parser.add_argument('--allow-read', action='store_true')
    parser.add_argument('--fixture', action='store_true', help='controlled SQLite only; never accesses WeChat')
    args = parser.parse_args()
    receiver = Receiver(account_id=args.account_id, pid=args.pid, created_at_ms=args.created_at_ms,
        binding_path=args.binding_path, state_dir=args.state_dir, allowed_targets=args.allowed_target,
        allow_read=args.allow_read, fixture=args.fixture)
    serve(receiver, sys.stdin.buffer, sys.stdout.buffer)


if __name__ == '__main__':
    main()
