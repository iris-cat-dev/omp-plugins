"""Pinned-build, explicitly authorized Windows text and image transport."""
import ctypes as c
import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct
from process_modules import loaded_modules

CALLS = ('application', 'scheduler', 'schedule', 'context', 'provider', 'manager',
         'text', 'image', 'emoticon', 'copyWide', 'validateGif', 'probeGif',
         'releaseProbe', 'send', 'allocate', 'free', 'accountRoot',
         'contextVtable', 'emoticonVtable')
OPTIONAL_CALLS = {'emoticon', 'validateGif', 'probeGif', 'releaseProbe', 'emoticonVtable'}
PROJECT = Path(__file__).resolve().parent.parent
SOURCE = PROJECT / 'native' / 'engine' / 'bridge.cpp'
PROFILES = SOURCE.with_name('profiles.json')
IDENTITY = re.compile(r'(?:wxid_[A-Za-z0-9_-]+|[0-9]+@chatroom)\Z')
ACCOUNT = re.compile(r'wxid_[A-Za-z0-9_-]+\Z')
DIGEST = re.compile(r'[0-9a-f]{64}\Z')


class BridgeError(Exception):
    def __init__(self, code, message, *, outcome=None, request_id=None):
        super().__init__(message)
        self.code, self.outcome, self.request_id = code, outcome, request_id


def fail(code, message):
    raise BridgeError(code, message)


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('重复 JSON 属性')
            result[key] = value
        return result

    def finite(value):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError('不允许非有限数字')
        return number

    def constant(value):
        raise ValueError('不允许非有限数字')

    return json.loads(data, object_pairs_hook=pairs, parse_constant=constant, parse_float=finite)


def identity(value, *, account=False):
    pattern = ACCOUNT if account else IDENTITY
    if not isinstance(value, str) or len(value) > 127 or not pattern.fullmatch(value):
        fail('invalid_params', '需要稳定 wxid_… 账号 ID 或数字@chatroom 群 ID')
    return value


def integer(value, name, minimum=1, maximum=0xffffffff):
    if type(value) is not int or not minimum <= value <= maximum:
        fail('invalid_params', f'{name} 超出允许整数范围')
    return value


def digest_file(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


class NativeRequest(c.Structure):
    _fields_ = [(name, c.c_uint32) for name in
                ('size', 'pid', 'ownerPid', 'kind', 'timestamp', 'imageSize')] + [
        ('rva', c.c_uint32 * len(CALLS)), ('account', c.c_char * 128),
        ('target', c.c_char * 128), ('value', c.c_char * 4096),
        ('status', c.c_uint32), ('stage', c.c_uint32), ('exception', c.c_uint32)]


assert c.sizeof(NativeRequest) == 4464


def encode_request(profile, pid, account, target, kind, value=''):
    integer(pid, 'processId')
    identity(account, account=True)
    identity(target)
    if type(kind) is not int or kind not in (0, 1, 2):
        fail('invalid_params', '原生操作种类无效')
    try:
        encoded = value.encode('utf-8') if isinstance(value, str) else None
    except UnicodeError:
        encoded = None
    if encoded is None or b'\0' in encoded or len(encoded) > 4094 or (kind and not encoded):
        fail('invalid_params', '内容需要 1–4094 UTF-8 字节，且不能包含 NUL')
    request = NativeRequest()
    request.size, request.pid, request.ownerPid, request.kind = c.sizeof(request), pid, os.getpid(), kind
    request.timestamp, request.imageSize = profile['timestamp'], profile['imageSize']
    request.rva[:] = [profile['addresses'][name] or 0 for name in CALLS]
    request.account, request.target, request.value = account.encode('ascii'), target.encode('ascii'), encoded
    return request


def load_profiles():
    try:
        profiles = strict_json(PROFILES.read_text(encoding='utf-8-sig'))
        if not isinstance(profiles, list) or not profiles:
            raise ValueError('配置应为非空列表')
        fingerprints = set()
        for profile in profiles:
            if not isinstance(profile, dict) or set(profile) != {'version', 'size', 'sha256', 'timestamp', 'imageSize', 'addresses'}:
                raise ValueError('配置字段不完整')
            if not isinstance(profile['version'], str) or not re.fullmatch(r'\d+\.\d+\.\d+\.\d+', profile['version']):
                raise ValueError('版本无效')
            for key in ('size', 'timestamp', 'imageSize'):
                integer(profile[key], key)
            if not isinstance(profile['sha256'], str) or not DIGEST.fullmatch(profile['sha256']):
                raise ValueError('SHA256 无效')
            addresses = profile['addresses']
            if not isinstance(addresses, dict) or set(addresses) != set(CALLS):
                raise ValueError('地址配置不完整')
            for name, rva in addresses.items():
                if rva is None and name in OPTIONAL_CALLS:
                    continue
                integer(rva, name, 0 if name in OPTIONAL_CALLS else 1, profile['imageSize'] - 1)
            fingerprint = (profile['size'], profile['sha256'])
            if fingerprint in fingerprints:
                raise ValueError('重复构建指纹')
            fingerprints.add(fingerprint)
        return profiles
    except (OSError, ValueError, TypeError, KeyError, BridgeError) as error:
        raise BridgeError('invalid_profile', f'原生配置不可用：{error}') from error


def inspect_pe(path):
    """Read bounded PE headers; never load the file as a module."""
    try:
        with Path(path).open('rb') as stream:
            size = os.fstat(stream.fileno()).st_size
            dos = stream.read(64)
            if len(dos) != 64 or dos[:2] != b'MZ':
                raise ValueError('DOS 头无效')
            offset = struct.unpack_from('<I', dos, 60)[0]
            if not 64 <= offset <= min(1048576, size - 24):
                raise ValueError('PE 头偏移无效')
            stream.seek(offset)
            header = stream.read(24)
            if header[:4] != b'PE\0\0':
                raise ValueError('PE 签名无效')
            machine, sections, timestamp, _, _, optional_size, characteristics = struct.unpack_from('<HHIIIHH', header, 4)
            if machine != 0x8664 or not characteristics & 0x2000 or not 1 <= sections <= 96 or not 112 <= optional_size <= 4096:
                raise ValueError('需要 x64 DLL')
            optional = stream.read(optional_size)
            if len(optional) != optional_size or struct.unpack_from('<H', optional)[0] != 0x20b:
                raise ValueError('PE32+ 可选头无效')
            image_size, headers_size = struct.unpack_from('<II', optional, 56)
            if not image_size or not offset + 24 + optional_size + sections * 40 <= headers_size <= size:
                raise ValueError('映像或头大小无效')
            ranges = []
            for _ in range(sections):
                section = stream.read(40)
                if len(section) != 40:
                    raise ValueError('节表不完整')
                virtual_size, rva, raw_size, raw_pointer = struct.unpack_from('<IIII', section, 8)
                extent = max(virtual_size, raw_size)
                if not extent or rva < headers_size or rva + extent > image_size or (raw_size and (raw_pointer < headers_size or raw_pointer + raw_size > size)):
                    raise ValueError('节范围越界')
                if any(rva < end and rva + extent > start for start, end, _ in ranges):
                    raise ValueError('节范围重叠')
                ranges.append((rva, rva + extent, struct.unpack_from('<I', section, 36)[0]))
            return {'timestamp': timestamp, 'imageSize': image_size, 'sections': ranges}
    except (OSError, ValueError, struct.error) as error:
        raise BridgeError('invalid_pe', f'PE 文件检查失败：{error}') from error


def select_profile(path, profiles):
    path = Path(path)
    try:
        size = path.stat().st_size
        candidates = [profile for profile in profiles if profile['size'] == size]
        digest = digest_file(path) if candidates else None
        matches = [profile for profile in candidates if profile['sha256'] == digest]
        if len(matches) != 1:
            fail('unsupported_build', '文件大小与 SHA256 未唯一匹配支持的微信构建')
        profile = matches[0]
        pe = inspect_pe(path)
        if any(pe[key] != profile[key] for key in ('timestamp', 'imageSize')):
            fail('invalid_pe', 'PE 指纹与地址配置不一致')
        for name, rva in profile['addresses'].items():
            if not rva and name in OPTIONAL_CALLS:
                continue
            section = next((flags for start, end, flags in pe['sections'] if start <= rva < end), None)
            required_flag = 0x40000000 if name in {'accountRoot', 'contextVtable', 'emoticonVtable'} else 0x20000000
            if section is None or not section & required_flag:
                fail('invalid_pe', f'{name} 地址不在合法映像节中')
        return profile
    except OSError as error:
        raise BridgeError('invalid_pe', f'不能读取模块文件：{error}') from error


def current_build(engine_dir):
    try:
        engine_dir = Path(engine_dir).resolve(strict=True)
        build = strict_json((engine_dir / 'current.json').read_text(encoding='utf-8-sig'))
        if not isinstance(build, dict) or set(build) != {'file', 'sha256', 'sourceSha256'}:
            raise ValueError('构建记录字段不完整或包含未知字段')
        if any(not isinstance(build[key], str) or not DIGEST.fullmatch(build[key]) for key in ('sha256', 'sourceSha256')):
            raise ValueError('构建摘要无效')
        if not isinstance(build['file'], str) or not build['file'] or '\x00' in build['file']:
            raise ValueError('构建文件路径无效')
        selected = Path(build['file'])
        path = (selected if selected.is_absolute() else engine_dir / selected).resolve(strict=True)
        if not path.is_relative_to(engine_dir) or path.name != 'omp-wechat-send.dll':
            raise ValueError('构建文件不在指定目录内')
        if digest_file(SOURCE) != build['sourceSha256'] or digest_file(path) != build['sha256']:
            raise ValueError('源码或构建摘要不匹配，请重新构建')
        inspect_pe(path)
        return {**build, 'file': str(path)}
    except (OSError, ValueError, TypeError, BridgeError) as error:
        raise BridgeError('invalid_build', f'原生构建不可用：{error}') from error


def inspect(engine_dir, module_file=None):
    profiles = load_profiles()
    current_build(engine_dir)
    result = {'requestSize': c.sizeof(NativeRequest), 'callCount': len(CALLS),
              'buildVerified': True, 'profileCount': len(profiles),
              'versions': [profile['version'] for profile in profiles]}
    if module_file is not None:
        if not isinstance(module_file, str) or not Path(module_file).is_absolute():
            fail('invalid_params', 'moduleFile 必须是绝对路径')
        profile = select_profile(module_file, profiles)
        result.update(version=profile['version'], fileFingerprintMatched=True)
    return result


class ConnectionLease:
    """Exclusive ownership for this project's selected process incarnation."""
    def __init__(self, process_id, process_created_at_ms):
        if os.name != 'nt':
            fail('unsupported_platform', '连接独占锁仅支持 Windows')
        from ctypes import wintypes as w
        integer(process_id, 'processId')
        integer(process_created_at_ms, 'processCreatedAtMs', 1, 2**53 - 1)
        self.handle = None
        self.api = c.WinDLL('kernel32', use_last_error=True)
        self.api.CreateMutexW.argtypes = [c.c_void_p, w.BOOL, w.LPCWSTR]
        self.api.CreateMutexW.restype = w.HANDLE
        self.api.ReleaseMutex.argtypes = [w.HANDLE]
        self.api.ReleaseMutex.restype = w.BOOL
        self.api.CloseHandle.argtypes = [w.HANDLE]
        self.api.CloseHandle.restype = w.BOOL
        name = f'Global\\OMP.WechatCompanion.Send.{process_id}.{process_created_at_ms}'
        c.set_last_error(0)
        handle = self.api.CreateMutexW(None, True, name)
        error = c.get_last_error()
        if not handle:
            raise c.WinError(error)
        if error == 183:  # ERROR_ALREADY_EXISTS: no ownership was acquired.
            self.api.CloseHandle(handle)
            fail('connection_in_use', '该指定进程已由本项目另一个原生宿主连接')
        self.handle = handle

    def close(self):
        handle, self.handle = self.handle, None
        if handle is not None:
            try:
                if not self.api.ReleaseMutex(handle):
                    raise c.WinError(c.get_last_error())
            finally:
                self.api.CloseHandle(handle)


class NativeSender:
    def __init__(self, account_id, process_id, process_created_at_ms, engine_dir):
        if os.name != 'nt' or c.sizeof(c.c_void_p) != 8:
            fail('unsupported_platform', '原生桥仅支持 Windows x64')
        import psutil
        from ctypes import wintypes as w
        self.account_id = identity(account_id, account=True)
        self.process_id = integer(process_id, 'processId')
        self.created_at_ms = integer(process_created_at_ms, 'processCreatedAtMs', 1, 2**53 - 1)
        try:
            self.process = psutil.Process(self.process_id)
        except (psutil.NoSuchProcess, psutil.AccessDenied) as error:
            raise BridgeError('identity_mismatch', '绑定的微信进程已退出或不可访问，请重新核验当前机器人进程。') from error
        self.handle = None
        self.local = None
        self.lease = None
        self.poisoned = False
        self._check_process()
        modules = self._modules(('weixin.dll',))
        cores = [(path, base) for path, base in modules.items() if Path(path).name.casefold() == 'weixin.dll']
        if len(cores) != 1:
            fail('identity_mismatch', '指定进程的 Weixin.dll 无法唯一确定')
        self.core_path, self.core_base = cores[0]
        self.profile = select_profile(self.core_path, load_profiles())
        build = current_build(engine_dir)
        self.dll = Path(build['file'])
        self.api = c.WinDLL('kernel32', use_last_error=True)
        signatures = {
            'OpenProcess': (w.HANDLE, [w.DWORD, w.BOOL, w.DWORD]),
            'VirtualAllocEx': (c.c_void_p, [w.HANDLE, c.c_void_p, c.c_size_t, w.DWORD, w.DWORD]),
            'VirtualFreeEx': (w.BOOL, [w.HANDLE, c.c_void_p, c.c_size_t, w.DWORD]),
            'WriteProcessMemory': (w.BOOL, [w.HANDLE, c.c_void_p, c.c_void_p, c.c_size_t, c.POINTER(c.c_size_t)]),
            'ReadProcessMemory': (w.BOOL, [w.HANDLE, c.c_void_p, c.c_void_p, c.c_size_t, c.POINTER(c.c_size_t)]),
            'CreateRemoteThread': (w.HANDLE, [w.HANDLE, c.c_void_p, c.c_size_t, c.c_void_p, c.c_void_p, w.DWORD, c.c_void_p]),
            'WaitForSingleObject': (w.DWORD, [w.HANDLE, w.DWORD]),
            'GetExitCodeThread': (w.BOOL, [w.HANDLE, c.POINTER(w.DWORD)]),
            'CloseHandle': (w.BOOL, [w.HANDLE]),
            'GetModuleHandleExW': (w.BOOL, [w.DWORD, c.c_void_p, c.POINTER(w.HMODULE)]),
            'GetModuleFileNameW': (w.DWORD, [w.HMODULE, w.LPWSTR, w.DWORD]),
            'FreeLibrary': (w.BOOL, [w.HMODULE]),
        }
        for name, (result, arguments) in signatures.items():
            getattr(self.api, name).restype = result
            getattr(self.api, name).argtypes = arguments
        self.lease = ConnectionLease(self.process_id, self.created_at_ms)
        try:
            self.handle = self.api.OpenProcess(0x43a, False, self.process_id)
            if not self.handle:
                raise c.WinError(c.get_last_error())
            # Read the selected account before any LoadLibrary/CreateRemoteThread.
            self.verify_identity()
            self.remote_base = self._modules((self.dll.name,)).get(str(self.dll).casefold())
            if self.remote_base is None:
                address = c.cast(self.api.LoadLibraryW, c.c_void_p).value
                owner = w.HMODULE()
                if not self.api.GetModuleHandleExW(6, address, c.byref(owner)):
                    raise c.WinError(c.get_last_error())
                owner_path = c.create_unicode_buffer(32768)
                if not self.api.GetModuleFileNameW(owner, owner_path, len(owner_path)):
                    raise c.WinError(c.get_last_error())
                loaders = self._modules((Path(owner_path.value).name,))
                if len(loaders) != 1:
                    fail('native_connect_failed', '指定进程的系统加载器无法唯一核验')
                loader = next(iter(loaders.values()))
                self._invoke(loader + address - owner.value, c.create_unicode_buffer(str(self.dll)), 30000)
                self.remote_base = self._modules((self.dll.name,)).get(str(self.dll).casefold())
                if self.remote_base is None:
                    fail('native_connect_failed', '原生桥未加载到指定进程')
            self.verify_identity()
            self.local = c.WinDLL(str(self.dll))
            self.entry = self.remote_base + c.cast(self.local.CompanionWechatSend, c.c_void_p).value - self.local._handle
            self.send(self.account_id, 0)
        except BaseException:
            self.close()
            raise

    def _check_process(self):
        import psutil
        try:
            if (not self.process.is_running() or round(self.process.create_time() * 1000) != self.created_at_ms
                    or self.process.name().casefold() != 'weixin.exe'):
                fail('identity_mismatch', '指定 PID、创建时间或进程名称已变化')
        except (psutil.NoSuchProcess, psutil.AccessDenied) as error:
            raise BridgeError('identity_mismatch', '无法核对指定进程身份') from error

    def _modules(self, module_names):
        try:
            return loaded_modules(self.process.pid, module_names)
        except OSError as error:
            raise BridgeError('identity_mismatch', '无法核验指定进程当前操作所需的映像模块。') from error

    def _read(self, address, size):
        if not address or not 1 <= size <= 4096:
            fail('identity_mismatch', '账号内存地址无效')
        buffer = c.create_string_buffer(size)
        count = c.c_size_t()
        if not self.api.ReadProcessMemory(self.handle, address, buffer, size, c.byref(count)) or count.value != size:
            fail('identity_mismatch', '无法完整核对指定账号内存')
        return buffer.raw

    def _pointer(self, address):
        return struct.unpack('<Q', self._read(address, 8))[0]

    def verify_identity(self):
        if self.poisoned or not self.handle:
            fail('restart_required', '当前原生连接已封口，请关闭并重新启动宿主')
        self._check_process()
        if self._modules(('weixin.dll',)).get(self.core_path) != self.core_base:
            fail('identity_mismatch', '指定进程的核心模块已变化')
        dos = self._read(self.core_base, 64)
        offset = struct.unpack_from('<I', dos, 60)[0]
        if dos[:2] != b'MZ' or not 64 <= offset <= 1048576:
            fail('identity_mismatch', '运行中核心模块头无效')
        pe = self._read(self.core_base + offset, 88)
        if (pe[:4] != b'PE\0\0' or struct.unpack_from('<H', pe, 4)[0] != 0x8664
                or struct.unpack_from('<I', pe, 8)[0] != self.profile['timestamp']
                or struct.unpack_from('<H', pe, 24)[0] != 0x20b
                or struct.unpack_from('<I', pe, 80)[0] != self.profile['imageSize']):
            fail('identity_mismatch', '运行中核心模块与已核对构建不一致')
        root_address = self.core_base + self.profile['addresses']['accountRoot']
        root = self._pointer(root_address)
        if not root:
            fail('identity_mismatch', '指定进程未登录绑定账号')
        context = self._pointer(root + 0x68)
        if not context or self._pointer(context) != self.core_base + self.profile['addresses']['contextVtable']:
            fail('identity_mismatch', '指定账号上下文无效')
        name = self._read(context + 0x48, 32)
        length, capacity = struct.unpack_from('<QQ', name, 16)
        expected = self.account_id.encode('ascii')
        if length != len(expected) or not length <= capacity <= 1048576:
            fail('identity_mismatch', '指定进程不是绑定账号')
        actual = self._read(struct.unpack_from('<Q', name)[0], length) if capacity > 15 else name[:length]
        if (actual != expected or self._pointer(root_address) != root
                or self._pointer(root + 0x68) != context or self._read(context + 0x48, 32) != name):
            fail('identity_mismatch', '绑定账号不匹配或账号正在切换')

    def _invoke(self, entry, value, timeout):
        self.verify_identity()
        address = self.api.VirtualAllocEx(self.handle, None, c.sizeof(value), 0x3000, 4)
        if not address:
            raise c.WinError(c.get_last_error())
        thread, completed = None, False
        try:
            written = c.c_size_t()
            if not self.api.WriteProcessMemory(self.handle, address, c.byref(value), c.sizeof(value), c.byref(written)) or written.value != c.sizeof(value):
                raise c.WinError(c.get_last_error())
            self.verify_identity()
            thread = self.api.CreateRemoteThread(self.handle, None, 0, entry, address, 0, None)
            if not thread:
                raise c.WinError(c.get_last_error())
            if self.api.WaitForSingleObject(thread, timeout) != 0:
                self.poisoned = True
                fail('native_unknown', '原生线程未完整结束，必须关闭宿主，禁止重发')
            completed = True
            result = c.c_uint32()
            if not self.api.GetExitCodeThread(thread, c.byref(result)):
                raise c.WinError(c.get_last_error())
            count = c.c_size_t()
            if not self.api.ReadProcessMemory(self.handle, address, c.byref(value), c.sizeof(value), c.byref(count)) or count.value != c.sizeof(value):
                fail('native_unknown', '原生回包不完整')
            return result.value
        finally:
            if thread:
                self.api.CloseHandle(thread)
            # An unfinished thread may still own its argument. Never free it early.
            if completed or not thread:
                self.api.VirtualFreeEx(self.handle, address, 0, 0x8000)

    def send(self, target, kind, value=''):
        request = encode_request(self.profile, self.process_id, self.account_id, target, kind, value)
        payload = bytes(request)[:-12]
        try:
            result = self._invoke(self.entry, request, 70000)
            expected_stage = {0: 1, 1: 2, 2: 4}[kind]
            if (result != 0 or request.status != 0 or request.exception != 0
                    or request.stage != expected_stage or bytes(request)[:-12] != payload):
                fail('native_unknown', f'原生结果无法确认 status={result}, stage={request.stage}, exception={request.exception}')
            return {'status': 0, 'stage': request.stage}
        except BaseException:
            self.poisoned = True
            raise

    def close(self):
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None
        if self.local:
            self.api.FreeLibrary(self.local._handle)
            self.local = None
        if self.lease:
            lease, self.lease = self.lease, None
            lease.close()
