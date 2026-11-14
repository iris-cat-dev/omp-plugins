"""Selected-process read-only identity and WCDB keys.

Config.Cipher object decoding adapted from wechatauto-replica
(https://github.com/fanyuantaier/wechatauto-replica). Changes:
no process discovery, no account discovery, no key cache, bounded reads,
identity before/after key acquisition, and only selected files authenticated.
No write/injection/thread/GUI API is declared here.
"""
import ctypes as c
import hashlib
import json
import os
from pathlib import Path
import re
import struct
from ctypes import wintypes as w

from .crypto import PageCipher, pbkdf2
from .errors import ReaderError
from process_modules import loaded_modules


class IdentityError(Exception):
    code = 'IDENTITY_MISMATCH'

    def __init__(self):
        super().__init__('指定进程、模块或登录账号已经变化，已停止读取。')


class SelectedProcess:
    def __init__(self, account_id, pid, created_at_ms):
        if os.name != 'nt' or c.sizeof(c.c_void_p) != 8:
            raise ReaderError('DEPENDENCY_MISSING')
        import psutil
        self.account_id, self.pid, self.created_at_ms = account_id, pid, created_at_ms
        self.handle = None
        try:
            self.process = psutil.Process(pid)
        except (psutil.NoSuchProcess, psutil.AccessDenied) as error:
            raise IdentityError() from error
        self.api = c.WinDLL('kernel32', use_last_error=True)
        for name, result, args in (
            ('OpenProcess', w.HANDLE, [w.DWORD, w.BOOL, w.DWORD]),
            ('ReadProcessMemory', w.BOOL, [w.HANDLE, c.c_void_p, c.c_void_p, c.c_size_t, c.POINTER(c.c_size_t)]),
            ('VirtualQueryEx', c.c_size_t, [w.HANDLE, c.c_void_p, c.c_void_p, c.c_size_t]),
            ('CloseHandle', w.BOOL, [w.HANDLE]),
        ):
            method = getattr(self.api, name)
            method.restype, method.argtypes = result, args
        try:
            self._check_process()
            modules = self._modules(('weixin.dll',))
            cores = [(name, base) for name, base in modules.items() if Path(name).name.casefold() == 'weixin.dll']
            if len(cores) != 1:
                raise IdentityError()
            self.module_path, self.module_base = cores[0]
            profiles = json.loads((Path(__file__).resolve().parents[2] / 'native' / 'engine' / 'profiles.json').read_text('utf-8'))
            size = Path(self.module_path).stat().st_size
            candidates = [profile for profile in profiles if profile['size'] == size]
            digest = hashlib.sha256()
            if not candidates:
                raise IdentityError()
            with open(self.module_path, 'rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
            candidates = [profile for profile in candidates if profile['sha256'] == digest.hexdigest()]
            if len(candidates) != 1:
                raise IdentityError()
            self.profile = candidates[0]
            self.handle = self.api.OpenProcess(0x410, False, pid)  # QUERY_INFORMATION | VM_READ only
            if not self.handle:
                raise IdentityError()
            self.verify()
        except BaseException:
            self.close()
            raise

    def _check_process(self):
        import psutil
        try:
            if (not self.process.is_running() or self.process.pid != self.pid
                    or round(self.process.create_time() * 1000) != self.created_at_ms
                    or self.process.name().casefold() != 'weixin.exe'):
                raise IdentityError()
        except (psutil.Error, OSError):
            raise IdentityError() from None

    def _modules(self, module_names):
        try:
            return loaded_modules(self.process.pid, module_names)
        except OSError as error:
            raise IdentityError() from error

    def read(self, address, size):
        if not self.handle or not 0x10000 <= address < 0x800000000000 or not 0 < size <= 1024 * 1024:
            raise IdentityError()
        buffer, count = c.create_string_buffer(size), c.c_size_t()
        if not self.api.ReadProcessMemory(self.handle, address, buffer, size, c.byref(count)) or count.value != size:
            raise IdentityError()
        return buffer.raw

    def pointer(self, address):
        return struct.unpack('<Q', self.read(address, 8))[0]

    def verify(self):
        self._check_process()
        if self._modules(('weixin.dll',)).get(self.module_path) != self.module_base:
            raise IdentityError()
        dos = self.read(self.module_base, 64)
        offset = struct.unpack_from('<I', dos, 60)[0]
        if dos[:2] != b'MZ' or not 64 <= offset <= 1048576:
            raise IdentityError()
        pe = self.read(self.module_base + offset, 88)
        if (pe[:4] != b'PE\0\0' or struct.unpack_from('<H', pe, 4)[0] != 0x8664
                or struct.unpack_from('<I', pe, 8)[0] != self.profile['timestamp']
                or struct.unpack_from('<H', pe, 24)[0] != 0x20b
                or struct.unpack_from('<I', pe, 80)[0] != self.profile['imageSize']):
            raise IdentityError()
        root_address = self.module_base + self.profile['addresses']['accountRoot']
        root = self.pointer(root_address)
        context = self.pointer(root + 0x68)
        if self.pointer(context) != self.module_base + self.profile['addresses']['contextVtable']:
            raise IdentityError()
        value = self.read(context + 0x48, 32)
        length, capacity = struct.unpack_from('<QQ', value, 16)
        expected = self.account_id.encode('ascii')
        if length != len(expected) or not length <= capacity <= 1048576:
            raise IdentityError()
        actual = self.read(struct.unpack_from('<Q', value)[0], length) if capacity > 15 else value[:length]
        if (actual != expected or self.pointer(root_address) != root or self.pointer(root + 0x68) != context
                or self.read(context + 0x48, 32) != value):
            raise IdentityError()
        self._check_process()

    def _find(self, needle):
        class MemoryInfo(c.Structure):
            _fields_ = [('BaseAddress', c.c_void_p), ('AllocationBase', c.c_void_p),
                        ('AllocationProtect', w.DWORD), ('PartitionId', w.WORD),
                        ('RegionSize', c.c_size_t), ('State', w.DWORD),
                        ('Protect', w.DWORD), ('Type', w.DWORD)]
        address, hits = 0, []
        while address < 0x800000000000:
            info = MemoryInfo()
            if not self.api.VirtualQueryEx(self.handle, address, c.byref(info), c.sizeof(info)):
                break
            base, size = info.BaseAddress or 0, info.RegionSize
            if not size or base + size <= address:
                raise IdentityError()
            if info.State == 0x1000 and info.Protect & 0xE6 and not info.Protect & 0x100:
                carry = b''
                for start in range(base, base + size, 1024 * 1024):
                    try:
                        data = self.read(start, min(1024 * 1024, base + size - start))
                    except IdentityError:
                        carry = b''  # Unreadable pages are not key candidates.
                        continue
                    block = carry + data
                    position = 0
                    while True:
                        position = block.find(needle, position)
                        if position < 0:
                            break
                        hits.append(start - len(carry) + position)
                        if len(hits) > 16384:
                            raise ReaderError('INVALID_DATABASE')
                        position += 1
                    carry = block[-(len(needle) - 1):]
            address = base + size
        return hits

    def keys(self, paths):
        self.verify()
        marker = b'com.Tencent.WCDB.Config.Cipher'
        mask = bytes.fromhex('d2c7442458020000004889442450488b450048844c2448488944254048584c24')
        pages = {}
        for path in paths:
            try:
                with path.open('rb') as stream:
                    pages[path] = stream.read(4096)
            except OSError:
                continue  # The caller reports missing capability per shard.
        keys, seen = {}, set()
        addresses = set(self._find(marker))
        for address in addresses:
            for node_address in self._find(struct.pack('<QQ', address, len(marker))):
                try:
                    node = self.read(node_address - 0x10, 0x50)
                    if struct.unpack_from('<QQ', node, 0x10) != (address, len(marker)):
                        continue
                    config = struct.unpack_from('<Q', node, 0x28)[0]
                    obj = self.read(config + 0x88, 0x28)
                    pointer, length = struct.unpack_from('<QQ', obj, 8)
                    if not 0 < length <= 1024:
                        continue
                    blob = self.read(pointer, length)
                except IdentityError:
                    continue
                decoded = bytes(value ^ mask[index % len(mask)] for index, value in enumerate(blob))
                for match in re.finditer(rb"[xX]'([0-9a-fA-F]{64,192})'", decoded):
                    run = match[1]
                    offsets = [0] if len(run) <= 96 else list(dict.fromkeys([*range(0, len(run) - 63, 32), len(run) - 64]))
                    for offset in offsets:
                        material = bytes.fromhex(run[offset:offset + 64].decode())
                        explicit = bytes.fromhex(run[offset + 64:offset + 96].decode()) if offset + 96 <= len(run) else None
                        for candidate in (material, material + explicit) if explicit else (material,):
                            if candidate in seen:
                                continue
                            seen.add(candidate)
                            for path, page in pages.items():
                                if path in keys or len(page) != 4096:
                                    continue
                                salt = candidate[32:] if len(candidate) == 48 else page[:16]
                                cipher = PageCipher(candidate[:32], pbkdf2(candidate[:32], bytes(v ^ 0x3a for v in salt), 2), len(candidate) == 48)
                                if cipher.authenticated(page, 1):
                                    keys[path] = candidate
        self.verify()
        return keys

    def close(self):
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None
