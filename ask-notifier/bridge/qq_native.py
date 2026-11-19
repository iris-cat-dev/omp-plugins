"""QQNT self-device adapter. Never uses UIAutomation, input, clipboard or focus APIs."""
import ctypes as c
from ctypes import wintypes as w
import json
import os
from pathlib import Path
import secrets
import time

from process_modules import loaded_modules
from qq_install import QQInstallation

MAX_LINE_BYTES = 65536


class QQGuardError(RuntimeError):
    def __init__(self, message, state='failed'):
        super().__init__(message)
        self.state = state

class QQBootstrapPending(QQGuardError):
    pass


def inspection(state, reason=None, account=None, version=None):
    return {'state': state, 'reason': reason, 'accountId': account, 'version': version}


class Overlapped(c.Structure):
    _fields_ = [('internal', c.c_size_t), ('internalHigh', c.c_size_t),
                ('offset', w.DWORD), ('offsetHigh', w.DWORD), ('event', w.HANDLE)]


class SecurityAttributes(c.Structure):
    _fields_ = [('length', w.DWORD), ('descriptor', c.c_void_p), ('inherit', w.BOOL)]


class BootstrapConfig(c.Structure):
    _fields_ = [('version', w.DWORD), ('host_pid', w.DWORD), ('script_length', w.DWORD),
                ('reserved', w.DWORD), ('script', c.c_char * 32768)]


def _api():
    api = c.WinDLL('kernel32', use_last_error=True)
    signatures = {
        'OpenProcess': (w.HANDLE, [w.DWORD, w.BOOL, w.DWORD]),
        'GetCurrentProcess': (w.HANDLE, []),
        'CloseHandle': (w.BOOL, [w.HANDLE]),
        'LocalFree': (c.c_void_p, [c.c_void_p]),
        'CreateMutexW': (w.HANDLE, [c.c_void_p, w.BOOL, w.LPCWSTR]),
        'ReleaseMutex': (w.BOOL, [w.HANDLE]),
        'CreateNamedPipeW': (w.HANDLE, [w.LPCWSTR, w.DWORD, w.DWORD, w.DWORD, w.DWORD, w.DWORD, w.DWORD, c.POINTER(SecurityAttributes)]),
        'ConnectNamedPipe': (w.BOOL, [w.HANDLE, c.POINTER(Overlapped)]),
        'DisconnectNamedPipe': (w.BOOL, [w.HANDLE]),
        'GetNamedPipeClientProcessId': (w.BOOL, [w.HANDLE, c.POINTER(w.ULONG)]),
        'CreateEventW': (w.HANDLE, [c.c_void_p, w.BOOL, w.BOOL, w.LPCWSTR]),
        'WaitForSingleObject': (w.DWORD, [w.HANDLE, w.DWORD]),
        'WaitForMultipleObjects': (w.DWORD, [w.DWORD, c.POINTER(w.HANDLE), w.BOOL, w.DWORD]),
        'ReadFile': (w.BOOL, [w.HANDLE, c.c_void_p, w.DWORD, c.POINTER(w.DWORD), c.POINTER(Overlapped)]),
        'WriteFile': (w.BOOL, [w.HANDLE, c.c_void_p, w.DWORD, c.POINTER(w.DWORD), c.POINTER(Overlapped)]),
        'GetOverlappedResult': (w.BOOL, [w.HANDLE, c.POINTER(Overlapped), c.POINTER(w.DWORD), w.BOOL]),
        'CancelIoEx': (w.BOOL, [w.HANDLE, c.POINTER(Overlapped)]),
        'VirtualAllocEx': (c.c_void_p, [w.HANDLE, c.c_void_p, c.c_size_t, w.DWORD, w.DWORD]),
        'VirtualFreeEx': (w.BOOL, [w.HANDLE, c.c_void_p, c.c_size_t, w.DWORD]),
        'WriteProcessMemory': (w.BOOL, [w.HANDLE, c.c_void_p, c.c_void_p, c.c_size_t, c.POINTER(c.c_size_t)]),
        'CreateRemoteThread': (w.HANDLE, [w.HANDLE, c.c_void_p, c.c_size_t, c.c_void_p, c.c_void_p, w.DWORD, c.c_void_p]),
        'GetExitCodeThread': (w.BOOL, [w.HANDLE, c.POINTER(w.DWORD)]),
        'GetModuleHandleExW': (w.BOOL, [w.DWORD, c.c_void_p, c.POINTER(w.HMODULE)]),
        'GetModuleFileNameW': (w.DWORD, [w.HMODULE, w.LPWSTR, w.DWORD]),
        'LoadLibraryExW': (w.HMODULE, [w.LPCWSTR, w.HANDLE, w.DWORD]),
        'GetProcAddress': (c.c_void_p, [w.HMODULE, c.c_char_p]),
        'FreeLibrary': (w.BOOL, [w.HMODULE]),
    }
    for name, (result, args) in signatures.items():
        getattr(api, name).restype, getattr(api, name).argtypes = result, args
    return api


def _user_security(api):
    """Pipe DACL grants only this Windows user; remote pipe clients are also rejected."""
    adv = c.WinDLL('advapi32', use_last_error=True)
    adv.OpenProcessToken.argtypes, adv.OpenProcessToken.restype = [w.HANDLE, w.DWORD, c.POINTER(w.HANDLE)], w.BOOL
    adv.GetTokenInformation.argtypes, adv.GetTokenInformation.restype = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.POINTER(w.DWORD)], w.BOOL
    adv.ConvertSidToStringSidW.argtypes, adv.ConvertSidToStringSidW.restype = [c.c_void_p, c.POINTER(c.c_void_p)], w.BOOL
    adv.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [w.LPCWSTR, w.DWORD, c.POINTER(c.c_void_p), c.c_void_p]
    adv.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = w.BOOL
    token, sid, descriptor = w.HANDLE(), c.c_void_p(), c.c_void_p()
    if not adv.OpenProcessToken(api.GetCurrentProcess(), 8, c.byref(token)):
        raise c.WinError(c.get_last_error())
    try:
        needed = w.DWORD()
        adv.GetTokenInformation(token, 1, None, 0, c.byref(needed))
        if not needed.value:
            raise c.WinError(c.get_last_error())
        data = c.create_string_buffer(needed.value)
        if not adv.GetTokenInformation(token, 1, data, len(data), c.byref(needed)):
            raise c.WinError(c.get_last_error())
        if not adv.ConvertSidToStringSidW(c.cast(data, c.POINTER(c.c_void_p))[0], c.byref(sid)):
            raise c.WinError(c.get_last_error())
        sddl = 'D:P(A;;GA;;;' + c.wstring_at(sid) + ')'
        if not adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, c.byref(descriptor), None):
            raise c.WinError(c.get_last_error())
        return descriptor
    finally:
        if sid:
            api.LocalFree(sid)
        api.CloseHandle(token)


class NativeConnection:
    def __init__(self, selected, install):
        self.selected = dict(selected)
        self.install = install
        self.api = _api()
        self.process = self.pipe = self.lease = None
        self.sequence = 0
        self.buffer = b''
        self.closed = False
        try:
            self._verify()
            self.process = self.api.OpenProcess(0x10043a, False, selected['pid'])
            if not self.process:
                raise c.WinError(c.get_last_error())
            c.set_last_error(0)
            self.lease = self.api.CreateMutexW(None, True, f"Local\\OMP.QQ.Ask.{selected['pid']}.{selected['createdAtMs']}")
            if not self.lease:
                raise c.WinError(c.get_last_error())
            if c.get_last_error() == 183:
                self.api.CloseHandle(self.lease)
                self.lease = None
                raise QQGuardError('该 QQ 进程已由另一个提醒宿主占用')
            nonce = secrets.token_hex(16)
            pipe_name = rf'\\.\pipe\OMP.QQ.Ask.{os.getpid()}.{nonce}'
            descriptor = _user_security(self.api)
            try:
                security = SecurityAttributes(c.sizeof(SecurityAttributes), descriptor, False)
                self.pipe = self.api.CreateNamedPipeW(pipe_name, 0x40080003, 8, 1, MAX_LINE_BYTES, MAX_LINE_BYTES, 0, c.byref(security))
            finally:
                self.api.LocalFree(descriptor)
            if self.pipe == c.c_void_p(-1).value:
                self.pipe = None
                raise c.WinError(c.get_last_error())
            root = Path(__file__).resolve().parents[1] / 'native' / 'qq'
            dll = root / 'omp_qq_bootstrap.dll'
            backend = root / 'background.cjs'
            if not dll.is_file() or not backend.is_file():
                raise QQGuardError('QQ 自研后台桥文件不完整；请重新准备完整插件', 'unsupported')
            config = {'pipeName': pipe_name, 'hostPid': os.getpid(), 'nonce': nonce}
            script = ('setImmediate(()=>{try{const filename=' + json.dumps(str(backend))
                      + ';const load=process.mainModule.require("node:module").createRequire(filename);'
                      + 'delete load.cache[load.resolve(filename)];load(filename)(Object.assign('
                      + json.dumps(config) + ',{hostAlive:__ompQQHostAlive}))}catch(e){}})')
            encoded = script.encode('utf-8')
            if len(encoded) > 32767:
                raise QQGuardError('QQ 后台桥路径过长')
            request = BootstrapConfig(1, os.getpid(), len(encoded), 0, encoded)
            self._bootstrap(dll, request)
            self._connect(15000)
        except BaseException:
            self.close(notify=False)
            raise

    def _verify(self):
        import psutil
        try:
            process = psutil.Process(self.selected['pid'])
            if (round(process.create_time() * 1000) != self.selected['createdAtMs']
                    or not self.install.belongs(process.exe(), self.install.discover())
                    or any(arg.startswith('--type=') for arg in process.cmdline()[1:])):
                raise QQGuardError('QQ 主进程身份已变化，未执行后台操作')
        except psutil.Error as error:
            raise QQGuardError('无法核对 QQ 主进程身份') from error

    def _invoke(self, entry, value):
        self._verify()
        address = self.api.VirtualAllocEx(self.process, None, c.sizeof(value), 0x3000, 4)
        if not address:
            raise c.WinError(c.get_last_error())
        thread, completed = None, False
        try:
            written = c.c_size_t()
            if not self.api.WriteProcessMemory(self.process, address, c.byref(value), c.sizeof(value), c.byref(written)) or written.value != c.sizeof(value):
                raise c.WinError(c.get_last_error())
            thread = self.api.CreateRemoteThread(self.process, None, 0, entry, address, 0, None)
            if not thread:
                raise c.WinError(c.get_last_error())
            if self.api.WaitForSingleObject(thread, 10000) != 0:
                raise QQBootstrapPending('QQ 后台桥载入线程未结束；须退出此 QQ 后才能重新接入')
            completed = True
            code = w.DWORD()
            if not self.api.GetExitCodeThread(thread, c.byref(code)):
                raise c.WinError(c.get_last_error())
            return code.value
        finally:
            if thread:
                self.api.CloseHandle(thread)
            if completed or not thread:
                self.api.VirtualFreeEx(self.process, address, 0, 0x8000)

    def _bootstrap(self, dll, request):
        modules = loaded_modules(self.selected['pid'], (dll.name,))
        remote = modules.get(str(dll).casefold())
        if modules and remote is None:
            raise QQGuardError('QQ 中存在其他路径的同名后台桥，未加载第二份')
        if remote is None:
            address = c.cast(self.api.LoadLibraryW, c.c_void_p).value
            owner = w.HMODULE()
            if not self.api.GetModuleHandleExW(6, address, c.byref(owner)):
                raise c.WinError(c.get_last_error())
            owner_name = c.create_unicode_buffer(32768)
            length = self.api.GetModuleFileNameW(owner, owner_name, len(owner_name))
            if not 0 < length < len(owner_name) - 1:
                raise QQGuardError('无法核对 Windows 加载器')
            loaders = loaded_modules(self.selected['pid'], (Path(owner_name.value).name,))
            if len(loaders) != 1:
                raise QQGuardError('QQ 中的 Windows 加载器不唯一')
            self._invoke(next(iter(loaders.values())) + address - owner.value, c.create_unicode_buffer(str(dll)))
            remote = loaded_modules(self.selected['pid'], (dll.name,)).get(str(dll).casefold())
            if remote is None:
                raise QQGuardError('自研后台桥未加载到 QQ 主进程')
        local = self.api.LoadLibraryExW(str(dll), None, 1)
        if not local:
            raise c.WinError(c.get_last_error())
        try:
            entry = self.api.GetProcAddress(local, b'OmpQQBootstrap')
            if not entry:
                raise QQGuardError('QQ 后台桥缺少约定入口')
            code = self._invoke(remote + entry - local, request)
            if code:
                raise QQGuardError(f'QQ 后台桥拒绝接入，状态码 {code}')
        finally:
            self.api.FreeLibrary(local)

    def _overlapped(self, operation, timeout):
        event = self.api.CreateEventW(None, True, False, None)
        if not event:
            raise c.WinError(c.get_last_error())
        pending = Overlapped(event=event)
        completed = False
        try:
            ok = operation(pending)
            error = 0 if ok else c.get_last_error()
            if error == 535:
                completed = True
                return 0
            if error not in (0, 997):
                raise c.WinError(error)
            if error == 997:
                handles = (w.HANDLE * 2)(self.process, event)
                waited = self.api.WaitForMultipleObjects(2, handles, False, timeout)
                if waited != 1 or self.api.WaitForSingleObject(self.process, 0) == 0:
                    raise QQGuardError('QQ 后台连接超时或客户端已退出')
            count = w.DWORD()
            if not self.api.GetOverlappedResult(self.pipe, c.byref(pending), c.byref(count), False):
                raise c.WinError(c.get_last_error())
            completed = True
            return count.value
        finally:
            if not completed:
                self.api.CancelIoEx(self.pipe, c.byref(pending))
                count = w.DWORD()
                self.api.GetOverlappedResult(self.pipe, c.byref(pending), c.byref(count), True)
            self.api.CloseHandle(event)

    def _connect(self, timeout):
        self._overlapped(lambda ov: self.api.ConnectNamedPipe(self.pipe, c.byref(ov)), timeout)
        pid = w.ULONG()
        if not self.api.GetNamedPipeClientProcessId(self.pipe, c.byref(pid)) or pid.value != self.selected['pid']:
            raise QQGuardError('后台管道连接者不是已核验的 QQ 主进程')

    def request(self, method, params, timeout=10000):
        if self.closed:
            raise QQGuardError('QQ 后台连接已封口')
        self._verify()
        self.sequence += 1
        data = (json.dumps({'id': self.sequence, 'method': method, 'params': params}, ensure_ascii=True, separators=(',', ':')) + '\n').encode('ascii')
        if len(data) > MAX_LINE_BYTES:
            raise QQGuardError('QQ 后台请求超长')
        source = c.create_string_buffer(data)
        count = w.DWORD()
        try:
            written = self._overlapped(lambda ov: self.api.WriteFile(self.pipe, source, len(data), c.byref(count), c.byref(ov)), timeout)
            if written != len(data):
                raise QQGuardError('QQ 后台请求写入不完整')
            deadline = time.monotonic() + timeout / 1000
            while b'\n' not in self.buffer:
                target = c.create_string_buffer(8192)
                remaining = max(1, round((deadline - time.monotonic()) * 1000))
                size = self._overlapped(lambda ov: self.api.ReadFile(self.pipe, target, len(target), c.byref(count), c.byref(ov)), remaining)
                if not size:
                    raise QQGuardError('QQ 后台连接中断')
                self.buffer += target.raw[:size]
                if len(self.buffer) > MAX_LINE_BYTES:
                    raise QQGuardError('QQ 后台回包超长')
            line, self.buffer = self.buffer.split(b'\n', 1)
            value = json.loads(line.decode('utf-8', errors='strict'))
            if not isinstance(value, dict) or value.get('id') != self.sequence:
                raise QQGuardError('QQ 后台返回非本次请求')
            if 'error' in value:
                raise QQGuardError('QQ 后台接口拒绝请求')
            if set(value) != {'id', 'result'} or not isinstance(value['result'], dict):
                raise QQGuardError('QQ 后台回包格式无效')
            return value['result']
        except BaseException:
            self.close(notify=False)
            raise

    def close(self, notify=True):
        if self.closed:
            return
        if notify and self.pipe:
            try:
                self.request('close', {}, 1000)
            except (OSError, QQGuardError, ValueError):
                pass
        self.closed = True
        if self.pipe:
            self.api.DisconnectNamedPipe(self.pipe)
            self.api.CloseHandle(self.pipe)
            self.pipe = None
        if self.process:
            self.api.CloseHandle(self.process)
            self.process = None
        if self.lease:
            self.api.ReleaseMutex(self.lease)
            self.api.CloseHandle(self.lease)
            self.lease = None


class QQNative:
    def __init__(self):
        self.install = QQInstallation()
        self.connection = None
        self.blocked_processes = {}

    def installation(self):
        value = self.install.discover()
        return {'executable': value['executable'], 'reason': value['reason']}

    def _processes(self):
        import psutil
        result = []
        installation = self.install.discover()
        for process in psutil.process_iter(['name']):
            if (process.info['name'] or '').lower() != 'qq.exe':
                continue
            try:
                if any(arg.startswith('--type=') for arg in process.cmdline()[1:]):
                    continue
                if not self.install.belongs(process.exe(), installation):
                    raise QQGuardError('发现非已核验官方安装的 QQ 主进程', 'unsupported')
                result.append({'pid': process.pid, 'createdAtMs': round(process.create_time() * 1000)})
            except psutil.NoSuchProcess:
                continue
            except psutil.Error as error:
                raise QQGuardError('QQ 进程信息无法读取，未尝试后台发送') from error
        return result

    def inspect(self):
        if os.name != 'nt' or c.sizeof(c.c_void_p) != 8:
            return inspection('unsupported', 'QQ 后台提醒仅支持 Windows x64'), None
        installed = self.install.discover()
        if installed['executable'] is None:
            return inspection('not_installed', installed['reason']), None
        try:
            processes = self._processes()
            if len(processes) != 1:
                self.close()
                return inspection('multiple_accounts' if processes else 'not_logged_in', '检测到多个 QQ 主进程' if processes else None, version=installed['version']), None
            selected = processes[0]
            identity = (selected['pid'], selected['createdAtMs'])
            if identity in self.blocked_processes:
                return inspection('error', self.blocked_processes[identity]), None
            try:
                modules = loaded_modules(selected['pid'], ('QQNT.dll', 'wrapper.node'))
            except OSError as error:
                # The just-created QQ image may still be before loader initialization.
                if error.winerror != 299:
                    raise
                return inspection('not_logged_in', 'QQ 原生加载器正在初始化', version=installed['version']), None
            if len(modules) != 2:
                return inspection('not_logged_in', 'QQ 原生服务正在初始化', version=installed['version']), None
            if self.connection is None or self.connection.selected != selected:
                self.close()
                self.connection = NativeConnection(selected, self.install)
            value = self.connection.request('inspect', {})
            if (set(value) != {'state', 'reason', 'accountId', 'version'}
                    or value['state'] not in ('ready', 'not_logged_in', 'unsupported', 'multiple_accounts', 'error')
                    or not (value['reason'] is None or isinstance(value['reason'], str))
                    or not (value['accountId'] is None or isinstance(value['accountId'], str))
                    or not (value['version'] is None or isinstance(value['version'], str))
                    or (value['state'] == 'ready' and not value['accountId'])):
                raise QQGuardError('QQ 后台身份回包无效')
            return value, {**selected, 'accountId': value['accountId']}
        except QQBootstrapPending as error:
            self.blocked_processes[identity] = str(error)
            self.close()
            return inspection('error', str(error)), None
        except (OSError, QQGuardError, ValueError) as error:
            self.close()
            return inspection('error', str(error)), None

    def prepare(self, selected):
        value, current = self.inspect()
        if value['state'] != 'ready' or current != selected:
            raise QQGuardError('QQ 账号或进程已变化，本次未提交')
        return {'connection': self.connection, 'selected': dict(selected)}

    def submit(self, prepared, key, target, text, before_submit):
        if prepared['connection'] is not self.connection:
            raise QQGuardError('QQ 后台连接代次已变化')
        self.connection._verify()
        before_submit()
        value = self.connection.request('send', {'requestId': key, 'target': target, 'text': text,
                                                'accountId': prepared['selected']['accountId']})
        if (set(value) != {'state', 'reason', 'accountId'}
                or value['state'] not in ('submitted', 'failed', 'unknown', 'not_logged_in', 'unsupported', 'multiple_accounts')
                or not (value['reason'] is None or isinstance(value['reason'], str))
                or value['accountId'] != prepared['selected']['accountId']):
            raise QQGuardError('QQ 原生提交回包无法确认')
        return value

    def begin_launch(self):
        import psutil
        if any((p.info['name'] or '').lower() == 'qq.exe' for p in psutil.process_iter(['name'])):
            return None
        return time.time_ns() // 1_000_000

    def claim_launch(self, pid, started):
        processes = self._processes()
        if len(processes) != 1 or processes[0]['pid'] != pid or processes[0]['createdAtMs'] < started:
            return None
        return {**processes[0], 'accountId': None}

    def exit_temporary(self, expected):
        import psutil
        value, selected = self.inspect()
        if value['state'] != 'ready' or selected != expected:
            raise QQGuardError('临时 QQ 身份或账号变化，保持客户端打开')
        process = psutil.Process(expected['pid'])
        children = [(child, child.create_time()) for child in process.children(recursive=True)]
        try:
            self.connection.request('exit', {})
        except (OSError, QQGuardError):
            # app.quit may finish the process before its reply is observed.
            if process.is_running():
                raise
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if not process.is_running() and all(not child.is_running() or child.create_time() != created for child, created in children):
                self.close()
                return inspection('not_logged_in', '临时 QQ 及已核对的子进程已正常退出')
            time.sleep(0.1)
        raise QQGuardError('QQ 已收到正常退出请求，但进程结束尚未确认；未强制结束')

    def close(self):
        connection, self.connection = self.connection, None
        if connection is not None:
            connection.close()
