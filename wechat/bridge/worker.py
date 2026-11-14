"""Account-bound NDJSON host. Native access is disabled unless explicitly enabled."""
import argparse
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import traceback
import uuid
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError

import sender
from sender import BridgeError, fail, identity, integer, strict_json

MAX_LINE_BYTES = 65536
MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_IMAGE_PIXELS = 25_000_000
MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024
REQUEST_ID = re.compile(r'[0-9a-f]{32}\Z')
ASSET_ID = re.compile(r'[0-9a-f]{32}\Z')
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS


def request_id(value):
    if not isinstance(value, str) or not REQUEST_ID.fullmatch(value) or value == '0' * 32:
        fail('invalid_params', 'requestId 需要 32 个小写十六进制字符（128 bit），且不能全为零')
    return value


def fields(params, required=(), optional=()):
    if not isinstance(params, dict) or not set(required) <= set(params) or set(params) - set(required) - set(optional):
        fail('invalid_params', '参数字段缺失或包含未允许字段')


def absolute_path(value, name):
    if not isinstance(value, str) or not value or '\0' in value or not Path(value).is_absolute():
        fail('invalid_params', f'{name} 必须是绝对路径')
    return Path(value)


def check_open_image(stream, expected, root):
    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
        fail('invalid_image', '图片必须是常规文件')
    if os.name == 'nt':
        import ctypes as c
        from ctypes import wintypes as w
        import msvcrt
        api = c.WinDLL('kernel32', use_last_error=True)
        get_path = api.GetFinalPathNameByHandleW
        get_path.argtypes = [w.HANDLE, w.LPWSTR, w.DWORD, w.DWORD]
        get_path.restype = w.DWORD
        buffer = c.create_unicode_buffer(32768)
        size = get_path(msvcrt.get_osfhandle(stream.fileno()), buffer, len(buffer), 0)
        if not 0 < size < len(buffer):
            fail('path_not_allowed', '无法核对已打开图片的最终路径')
        name = buffer.value
        if name.startswith('\\\\?\\UNC\\'):
            name = '\\\\' + name[8:]
        elif name.startswith('\\\\?\\'):
            name = name[4:]
        # The handle already returned the normalized final path; resolving it again hits MAX_PATH.
        opened = Path(name)
    else:
        opened = expected.resolve(strict=True)
        if not os.path.samestat(os.fstat(stream.fileno()), opened.stat()):
            fail('path_not_allowed', '图片路径在打开过程中发生变化')
    if not opened.is_relative_to(root):
        fail('path_not_allowed', '已打开图片不在 media-root 内')


def owner_alive(pid, created_at_ms):
    """Only query the recorded host; never enumerate processes or WeChat accounts."""
    import psutil
    try:
        process = psutil.Process(pid)
        return process.is_running() and round(process.create_time() * 1000) == created_at_ms
    except psutil.NoSuchProcess:
        return False
    except psutil.AccessDenied as error:
        raise BridgeError('owner_unverifiable', '无法核对旧提交宿主是否仍存活，不能解除阻塞') from error


class Worker:
    def __init__(self, account_id, state_dir, media_root, engine_dir, *, allow_native=False):
        self.account_id = identity(account_id, account=True)
        self.state_dir = absolute_path(str(state_dir), 'state-dir').resolve()
        self.media_root = absolute_path(str(media_root), 'media-root').resolve(strict=True)
        if not self.media_root.is_dir():
            fail('invalid_params', 'media-root 必须是已存在目录')
        self.engine_dir = absolute_path(str(engine_dir), 'engine-dir').resolve()
        self.allow_native = allow_native
        self.native = None
        self.targets = frozenset()
        self.restart_required = False
        self.closed = False
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.state_dir / 'state.sqlite3', timeout=5, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        try:
            with self.transaction():
                self.db.execute('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
                bound = self.db.execute("SELECT value FROM metadata WHERE key='account_id'").fetchone()
                if bound and bound['value'] != self.account_id:
                    fail('account_mismatch', '该状态库已绑定另一账号，不能复用')
                if not bound:
                    self.db.execute("INSERT INTO metadata VALUES ('account_id', ?)", (self.account_id,))
                self.db.execute('''CREATE TABLE IF NOT EXISTS assets (
                    asset_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, target_id TEXT NOT NULL,
                    sha256 TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
                    bytes INTEGER NOT NULL)''')
                self.db.execute('''CREATE TABLE IF NOT EXISTS submissions (
                    request_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, target_id TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('text','image')), payload TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('unknown','submitted')),
                    reviewed INTEGER NOT NULL DEFAULT 0 CHECK(reviewed IN (0,1)),
                    owner_pid INTEGER NOT NULL, owner_created_at_ms INTEGER NOT NULL,
                    asset_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)''')
            self.db.execute('PRAGMA journal_mode=WAL')
            self.db.execute('PRAGMA synchronous=FULL')
            self.snapshots = self.state_dir / 'media'
            self.snapshots.mkdir(exist_ok=True)
            if self.snapshots.resolve() != self.snapshots:
                fail('invalid_state', '状态图片目录不能是符号链接或目录联接')
        except BaseException:
            self.db.close()
            raise

    @contextmanager
    def transaction(self):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            yield
            self.db.execute('COMMIT')
        except BaseException:
            if self.db.in_transaction:
                self.db.execute('ROLLBACK')
            raise

    def _get(self, key):
        return self.db.execute('SELECT * FROM submissions WHERE request_id=?', (key,)).fetchone()

    def _unknown_count(self):
        return self.db.execute("SELECT count(*) FROM submissions WHERE status='unknown' AND reviewed=0").fetchone()[0]

    @staticmethod
    def _result(row):
        return {'requestId': row['request_id'], 'status': row['status'], 'reviewed': bool(row['reviewed'])}

    def _require_native(self):
        if not self.allow_native:
            fail('native_disabled', '默认离线模式；需要显式 --allow-native 才允许原生进程操作')

    def status(self, params):
        fields(params)
        return {'nativeAllowed': self.allow_native, 'connected': self.native is not None,
                'unknownCount': self._unknown_count(),
                'preparedImages': self.db.execute('SELECT count(*) FROM assets').fetchone()[0]}

    def inspect(self, params):
        fields(params, optional=('moduleFile',))
        if 'moduleFile' in params:
            absolute_path(params['moduleFile'], 'moduleFile')
        return sender.inspect(self.engine_dir, params.get('moduleFile'))

    def prepare_image(self, params):
        fields(params, ('targetId', 'path'))
        target = identity(params['targetId'])
        source = absolute_path(params['path'], 'path')
        try:
            resolved = source.resolve()
            if not resolved.is_relative_to(self.media_root):
                fail('path_not_allowed', '图片必须在指定 media-root 内')
            read_path = resolved
            if os.name == 'nt' and not str(resolved).startswith('\\\\?\\'):
                value = str(resolved)
                read_path = Path('\\\\?\\UNC\\' + value[2:] if value.startswith('\\\\') else '\\\\?\\' + value)
            if not read_path.is_file():
                fail('invalid_image', '图片路径不是常规文件')
            with read_path.open('rb') as stream:
                check_open_image(stream, resolved, self.media_root)
                # Bound bytes before decoding and detect changes that exceed the bound.
                if os.fstat(stream.fileno()).st_size > MAX_IMAGE_BYTES:
                    fail('invalid_image', '图片输入超过 32 MiB')
                data = stream.read(MAX_IMAGE_BYTES + 1)
            if len(data) > MAX_IMAGE_BYTES:
                fail('invalid_image', '图片输入超过 32 MiB')
            with warnings.catch_warnings():
                warnings.simplefilter('error', Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(data)) as image:
                    width, height = image.size
                    if width < 1 or height < 1 or width * height > MAX_IMAGE_PIXELS:
                        fail('invalid_image', '图片像素超过允许范围')
                    image.verify()
                with Image.open(io.BytesIO(data)) as image:
                    image.seek(0)
                    image.load()
                    with ImageOps.exif_transpose(image) as oriented:
                        with oriented.convert('RGBA' if 'A' in oriented.getbands() or 'transparency' in oriented.info else 'RGB') as normalized:
                            width, height = normalized.size
                            encoded = io.BytesIO()
                            normalized.save(encoded, format='PNG')
                            png = encoded.getvalue()
            if len(png) > MAX_SNAPSHOT_BYTES:
                fail('invalid_image', '归一化图片超过 128 MiB')
        except (OSError, ValueError, SyntaxError, UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
            raise BridgeError('invalid_image', f'无法解析完整图片：{error}') from error
        asset_id = uuid.uuid4().hex
        snapshot = self.snapshots / f'{asset_id}.png'
        digest = hashlib.sha256(png).hexdigest()
        try:
            with snapshot.open('xb') as stream:
                stream.write(png)
                stream.flush()
                os.fsync(stream.fileno())
            with self.transaction():
                self.db.execute('INSERT INTO assets VALUES (?,?,?,?,?,?,?)',
                                (asset_id, self.account_id, target, digest, width, height, len(png)))
        except BaseException:
            snapshot.unlink(missing_ok=True)
            raise
        return {'assetId': asset_id, 'width': width, 'height': height, 'bytes': len(png), 'sha256': digest}

    def connect(self, params):
        fields(params, ('processId', 'processCreatedAtMs', 'targets'))
        self._require_native()
        if self.restart_required:
            fail('restart_required', '本宿主发生过未知结果，请关闭并重新启动')
        if self.native is not None:
            fail('already_connected', '请先断开当前连接')
        pid = integer(params['processId'], 'processId')
        created = integer(params['processCreatedAtMs'], 'processCreatedAtMs', 1, 2**53 - 1)
        targets = params['targets']
        if not isinstance(targets, list) or not 1 <= len(targets) <= 256:
            fail('invalid_params', 'targets 需要 1–256 个稳定 ID')
        targets = frozenset(identity(target) for target in targets)
        if len(targets) != len(params['targets']):
            fail('invalid_params', 'targets 不允许重复')
        try:
            self.native = sender.NativeSender(self.account_id, pid, created, self.engine_dir)
        except BaseException:
            # A connection failure can leave a native loader thread outstanding.
            self.restart_required = True
            raise
        self.targets = targets
        return {'connected': True, 'version': self.native.profile['version']}

    def _asset(self, asset_id, target):
        if not isinstance(asset_id, str) or not ASSET_ID.fullmatch(asset_id):
            fail('invalid_params', 'assetId 无效')
        asset = self.db.execute('SELECT * FROM assets WHERE asset_id=?', (asset_id,)).fetchone()
        if asset is None:
            fail('asset_not_found', '图片快照不存在')
        if asset['account_id'] != self.account_id or asset['target_id'] != target:
            fail('asset_mismatch', '图片快照不属于当前账号和目标')
        return asset

    def _submit(self, params, kind):
        fields(params, ('requestId', 'targetId', 'text' if kind == 'text' else 'assetId'))
        key = request_id(params['requestId'])
        target = identity(params['targetId'])
        existing = self._get(key)
        if existing is not None and (existing['account_id'] != self.account_id
                                     or existing['target_id'] != target or existing['kind'] != kind):
            fail('conflict', 'requestId 已绑定其他目标或种类；原提交记录保持不变')
        asset = None
        if kind == 'text':
            value = params['text']
            try:
                encoded = value.encode('utf-8') if isinstance(value, str) else None
            except UnicodeError:
                encoded = None
            if not encoded or b'\0' in encoded or len(encoded) > 4094:
                fail('invalid_params', '文本需要 1–4094 UTF-8 字节，且不能包含 NUL')
            payload = value
        else:
            asset = self._asset(params['assetId'], target)
            payload = asset['sha256']
            value = str(self.snapshots / f"{asset['asset_id']}.png")
        with self.transaction():
            existing = self._get(key)
            if existing is not None:
                if (existing['account_id'] != self.account_id or existing['target_id'] != target
                        or existing['kind'] != kind or existing['payload'] != payload):
                    fail('conflict', 'requestId 已绑定其他内容；原提交记录保持不变')
                return self._result(existing)
            self._require_native()
            if self.restart_required:
                fail('restart_required', '本宿主发生过未知结果，请关闭并重新启动')
            if self._unknown_count():
                fail('review_required', '存在未核对的未知提交，禁止新发送')
            if self.native is None:
                fail('not_connected', '尚未连接指定微信进程')
            if target not in self.targets:
                fail('target_not_allowed', '目标不在本次连接授权范围内')
            if asset is not None:
                snapshot = Path(value)
                if (snapshot.resolve(strict=True).parent != self.snapshots
                        or snapshot.stat().st_size != asset['bytes'] or sender.digest_file(snapshot) != payload):
                    fail('asset_changed', '图片快照已改变，禁止发送')
                if len(value.encode('utf-16-le')) // 2 >= 1024 or len(value.encode('utf-8')) > 4094:
                    fail('invalid_params', '图片快照路径超过原生接口上限')
            self.native.verify_identity()
            import psutil
            host_created = round(psutil.Process(os.getpid()).create_time() * 1000)
            self.db.execute('''INSERT INTO submissions
                (request_id,account_id,target_id,kind,payload,status,owner_pid,owner_created_at_ms,asset_id)
                VALUES (?,?,?,?,?,'unknown',?,?,?)''',
                (key, self.account_id, target, kind, payload, os.getpid(), host_created,
                 asset['asset_id'] if asset is not None else None))
        # The durable unknown record is committed before entering the irreversible call.
        try:
            result = self.native.send(target, 1 if kind == 'text' else 2, value)
            if (not isinstance(result, dict) or type(result.get('status')) is not int or result['status'] != 0
                    or type(result.get('stage')) is not int or result['stage'] != (2 if kind == 'text' else 4)):
                fail('native_unknown', '原生发送回包不完整')
            with self.transaction():
                self.db.execute("UPDATE submissions SET status='submitted' WHERE request_id=? AND status='unknown'", (key,))
        except Exception as error:
            self.restart_required = True
            print(f'原生请求 {key} 保留 unknown：{type(error).__name__}: {error}', file=sys.stderr, flush=True)
            return {'requestId': key, 'status': 'unknown', 'reviewed': False}
        return {'requestId': key, 'status': 'submitted', 'reviewed': False}

    def submit_text(self, params):
        return self._submit(params, 'text')

    def submit_image(self, params):
        return self._submit(params, 'image')

    def submission(self, params):
        fields(params, ('requestId',))
        row = self._get(request_id(params['requestId']))
        if row is None:
            return {'found': False}
        return {'found': True, **self._result(row), 'targetId': row['target_id'], 'kind': row['kind']}

    def acknowledge(self, params):
        fields(params, ('requestId', 'resolution'))
        key = request_id(params['requestId'])
        if params['resolution'] != 'checked_no_retry':
            fail('invalid_params', '仅允许 checked_no_retry 人工核对封口')
        self._require_native()
        with self.transaction():
            row = self._get(key)
            if row is None:
                fail('submission_not_found', '没有找到该提交记录')
            if row['status'] != 'unknown':
                fail('invalid_resolution', '只有 unknown 提交需要人工核对')
            if not row['reviewed']:
                if owner_alive(row['owner_pid'], row['owner_created_at_ms']):
                    fail('owner_alive', '旧提交宿主仍然存活，必须先关闭旧宿主')
                self.db.execute('UPDATE submissions SET reviewed=1 WHERE request_id=?', (key,))
            return {'requestId': key, 'status': 'unknown', 'reviewed': True}

    def disconnect(self, params):
        fields(params)
        native, self.native = self.native, None
        self.targets = frozenset()
        if native is not None:
            native.close()
        return {'connected': False}

    def close(self, params):
        fields(params)
        if not self.closed:
            try:
                self.disconnect({})
            finally:
                self.closed = True
                self.db.close()
        return {'closed': True}

    def dispatch(self, method, params):
        methods = {'status', 'inspect', 'prepare_image', 'connect', 'submit_text', 'submit_image',
                   'submission', 'acknowledge', 'disconnect', 'close'}
        if not isinstance(method, str) or method not in methods:
            fail('method_not_found', '未知方法')
        if self.closed:
            fail('closed', '宿主已关闭')
        try:
            return getattr(self, method)(params)
        except Exception as error:
            if not isinstance(error, BridgeError):
                error = BridgeError('operation_failed', str(error))
            if method in {'submit_text', 'submit_image'}:
                key = params.get('requestId') if isinstance(params, dict) else None
                if isinstance(key, str) and REQUEST_ID.fullmatch(key) and key != '0' * 32:
                    error.request_id = key
                    try:
                        existing = self._get(key)
                        if existing is None:
                            error.outcome = 'not_submitted'
                        elif existing['status'] == 'unknown':
                            error.outcome = 'unknown'
                    except sqlite3.Error:
                        error.outcome = 'unknown'
            raise error


def error_response(rpc_id, error):
    detail = {'code': error.code, 'message': str(error)}
    if error.outcome is not None:
        detail['outcome'] = error.outcome
    if error.request_id is not None:
        detail['requestId'] = error.request_id
    return {'id': rpc_id, 'error': detail}


def serve(worker, input_stream, output_stream):
    try:
        while not worker.closed:
            line = input_stream.readline(MAX_LINE_BYTES + 1)
            if not line:
                break
            rpc_id, fatal = None, False
            try:
                if len(line) > MAX_LINE_BYTES or not line.endswith(b'\n'):
                    fatal = True
                    fail('invalid_request', 'NDJSON 行过长或不完整')
                try:
                    request = strict_json(line.decode('utf-8'))
                except (ValueError, UnicodeError, RecursionError) as error:
                    raise BridgeError('invalid_request', f'无效 JSON：{error}') from error
                if not isinstance(request, dict) or set(request) != {'id', 'method', 'params'}:
                    fail('invalid_request', '请求需要且仅允许 id、method、params')
                rpc_id = request['id']
                if (not isinstance(rpc_id, str) or not 1 <= len(rpc_id) <= 128
                        or any(ord(char) < 32 or 0xd800 <= ord(char) <= 0xdfff for char in rpc_id)):
                    rpc_id = None
                    fail('invalid_request', 'RPC id 必须是 1–128 字符字符串')
                if not isinstance(request['params'], dict):
                    fail('invalid_params', 'params 必须是对象')
                response = {'id': rpc_id, 'result': worker.dispatch(request['method'], request['params'])}
            except BridgeError as error:
                response = error_response(rpc_id, error)
            except Exception as error:
                traceback.print_exc(file=sys.stderr)
                response = error_response(rpc_id, BridgeError('internal_error', str(error)))
            output_stream.write(json.dumps(response, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode('utf-8') + b'\n')
            output_stream.flush()
            if fatal:
                break
    finally:
        worker.close({})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--account-id', required=True)
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--media-root', required=True)
    parser.add_argument('--engine-dir', required=True)
    parser.add_argument('--allow-native', action='store_true')
    args = parser.parse_args()
    try:
        worker = Worker(args.account_id, args.state_dir, args.media_root, args.engine_dir, allow_native=args.allow_native)
    except Exception as error:
        print(f'{getattr(error, "code", "startup_failed")}: {error}', file=sys.stderr, flush=True)
        return 2
    try:
        serve(worker, sys.stdin.buffer, sys.stdout.buffer)
    except BrokenPipeError:
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
