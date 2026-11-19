"""QQ self-device NDJSON worker. No WeChat imports and no chat history persistence."""
import argparse
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from qq_native import QQNative, QQGuardError

MAX_LINE_BYTES = 65536
REQUEST_ID = re.compile(r'(?!0{32}$)[0-9a-f]{32}\Z')
SEND_STATES = frozenset(('submitted', 'not_logged_in', 'unsupported', 'multiple_accounts', 'failed', 'unknown'))
TARGET_IDS = {'phone': 'self_mobile', 'pad': 'self_pad'}
SCHEMA_VERSION = 2
SUBMISSIONS_SCHEMA = '''CREATE TABLE submissions (
    request_id TEXT PRIMARY KEY, payload_sha256 TEXT NOT NULL,
    target_id TEXT NOT NULL CHECK(target_id IN ('self_mobile','self_pad')), account_id TEXT,
    state TEXT NOT NULL CHECK(state IN
        ('submitted','not_logged_in','unsupported','multiple_accounts','failed','unknown')),
    reason TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)'''


class RequestError(ValueError):
    pass


def fields(value, *names):
    if not isinstance(value, dict) or set(value) != set(names):
        raise RequestError('请求字段无效')


def request_id(value):
    if not isinstance(value, str) or REQUEST_ID.fullmatch(value) is None:
        raise RequestError('requestId 必须为非零的 32 位小写十六进制')
    return value


def target_id(value):
    if not isinstance(value, str) or value not in TARGET_IDS:
        raise RequestError('target 仅允许 phone 或 pad')
    return TARGET_IDS[value]


def text_bytes(value):
    if not isinstance(value, str) or not value or '\0' in value:
        raise RequestError('text 必须为非空、无 NUL 的文本')
    try:
        encoded = value.encode('utf-8', errors='strict')
    except UnicodeEncodeError as error:
        raise RequestError('text 含不完整 Unicode') from error
    if len(encoded) > 4094:
        raise RequestError('text 超过 4094 UTF-8 字节')
    return encoded


def result(state, reason=None, account=None):
    return {'state': state, 'reason': reason, 'accountId': account}


class Worker:
    def __init__(self, state_dir, *, desktop=None):
        self.state_dir = Path(state_dir)
        if not self.state_dir.is_absolute():
            raise RequestError('状态目录必须是绝对路径')
        self.desktop = desktop if desktop is not None else QQNative()
        self.db = None
        self.closed = False
        self.sealed = False
        self.launch_started = None
        self.temporary = None
        self.temporary_ready = False
        self.temporary_submitted = False
        self.temporary_unsafe = False
        self.exit_attempted = False

    def _open_database(self):
        if self.db is not None:
            return
        self.state_dir.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.state_dir / 'submissions.sqlite3', timeout=5, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            if db.execute('PRAGMA journal_mode=WAL').fetchone()[0] != 'wal':
                raise RuntimeError('QQ 发送日志无法启用 WAL')
            db.execute('PRAGMA synchronous=FULL')
            db.execute('BEGIN IMMEDIATE')
            version = db.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0, 1, SCHEMA_VERSION):
                raise RuntimeError('QQ 发送日志版本不受支持，未修改现有记录')
            exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='submissions'").fetchone()
            if exists is None:
                db.execute(SUBMISSIONS_SCHEMA)
            elif version < SCHEMA_VERSION:
                # DDL and data copy share one transaction: interrupted migration
                # retains the original table, including every unknown outcome.
                db.execute('ALTER TABLE submissions RENAME TO submissions_legacy')
                db.execute(SUBMISSIONS_SCHEMA)
                db.execute('''INSERT INTO submissions
                    (request_id,payload_sha256,target_id,account_id,state,reason,created_at)
                    SELECT request_id,payload_sha256,target_id,account_id,state,reason,created_at
                    FROM submissions_legacy''')
                db.execute('DROP TABLE submissions_legacy')
            db.execute(f'PRAGMA user_version={SCHEMA_VERSION}')
            db.execute('COMMIT')
        except BaseException:
            if db.in_transaction:
                db.execute('ROLLBACK')
            db.close()
            raise
        self.db = db

    @contextmanager
    def transaction(self):
        self._open_database()
        self.db.execute('BEGIN IMMEDIATE')
        try:
            yield
            self.db.execute('COMMIT')
        except BaseException:
            if self.db.in_transaction:
                self.db.execute('ROLLBACK')
            raise

    def _get(self, key):
        self._open_database()
        return self.db.execute('SELECT * FROM submissions WHERE request_id=?', (key,)).fetchone()

    @staticmethod
    def _result(row):
        return result(row['state'], row['reason'], row['account_id'])

    def _existing(self, key, target, digest):
        row = self._get(key)
        if row is not None and (row['target_id'] != target or row['payload_sha256'] != digest):
            raise RequestError('requestId 已绑定其他目标或内容，禁止重发')
        return row

    def _record(self, key, target, digest, value):
        with self.transaction():
            existing = self._existing(key, target, digest)
            if existing is not None:
                return self._result(existing), False
            self.db.execute('''INSERT INTO submissions
                (request_id,payload_sha256,target_id,account_id,state,reason)
                VALUES (?,?,?,?,?,?)''',
                (key, digest, target, value['accountId'], value['state'], value['reason']))
        return value, True

    def _finish(self, key, value):
        with self.transaction():
            self.db.execute('UPDATE submissions SET state=?,reason=? WHERE request_id=? AND state=\'unknown\'',
                            (value['state'], value['reason'], key))
        return value

    def inspect(self, params):
        fields(params)
        connection, selected = self.desktop.inspect()
        if self.temporary is not None and connection['state'] == 'ready':
            if (selected is not None
                    and selected['pid'] == self.temporary['pid']
                    and selected['createdAtMs'] == self.temporary['createdAtMs']
                    and self.temporary['accountId'] in (None, connection['accountId'])):
                self.temporary['accountId'] = connection['accountId']
                self.temporary_ready = True
            else:
                self.temporary = None
        return connection

    def installation(self, params):
        fields(params)
        return self.desktop.installation()

    def beginLaunch(self, params):
        fields(params)
        self.launch_started = self.desktop.begin_launch()
        self.temporary = None
        self.temporary_ready = self.temporary_submitted = self.temporary_unsafe = self.exit_attempted = False
        return {'mayLaunch': self.launch_started is not None}

    def claimLaunch(self, params):
        fields(params, 'pid')
        if type(params['pid']) is not int or not 1 <= params['pid'] <= 2**32 - 1:
            raise RequestError('QQ 启动 PID 无效')
        started, self.launch_started = self.launch_started, None
        if started is None:
            return {'owned': False}
        self.temporary = self.desktop.claim_launch(params['pid'], started)
        return {'owned': self.temporary is not None}

    def finishBatch(self, params):
        fields(params)
        if (self.temporary is None or not self.temporary_ready or not self.temporary_submitted
                or self.temporary_unsafe or self.sealed or self.exit_attempted):
            return None
        self.exit_attempted = True
        try:
            value = self.desktop.exit_temporary(self.temporary)
        except Exception as error:
            return {'state': 'error',
                    'reason': str(error) if isinstance(error, QQGuardError) else '临时 QQ 正常退出未确认；未重试或强制终止，请核对客户端',
                    'accountId': None, 'version': None}
        self.temporary = None
        return value


    def query(self, params):
        fields(params, 'requestId', 'target', 'text')
        key = request_id(params['requestId'])
        target = target_id(params['target'])
        digest = hashlib.sha256(text_bytes(params['text'])).hexdigest()
        row = self._existing(key, target, digest)
        return {'found': False} if row is None else {'found': True, **self._result(row)}

    def send(self, params):
        try:
            value = self._send(params)
        except Exception:
            self.temporary_unsafe = True
            raise
        if value['state'] != 'submitted':
            self.temporary_unsafe = True
        return value

    def _send(self, params):
        fields(params, 'requestId', 'target', 'text')
        key = request_id(params['requestId'])
        target = target_id(params['target'])
        digest = hashlib.sha256(text_bytes(params['text'])).hexdigest()
        existing = self._existing(key, target, digest)
        if existing is not None:
            return self._result(existing)
        if self.sealed:
            return self._record(key, target, digest, result('failed', 'QQ 工作进程存在未决提交，已停止后续发送；旧 requestId 禁止重发'))[0]
        connection, selected = self.desktop.inspect()
        if connection['state'] != 'ready':
            state = connection['state'] if connection['state'] in SEND_STATES else 'failed'
            return self._record(key, target, digest, result(state, connection['reason'], connection['accountId']))[0]
        try:
            prepared = self.desktop.prepare(selected)
        except QQGuardError as error:
            return self._record(key, target, digest, result(error.state, str(error), connection['accountId']))[0]
        except Exception:
            return self._record(key, target, digest, result('failed', 'QQ 提交前后台身份核验失败，本次未提交', connection['accountId']))[0]
        value, inserted = self._record(key, target, digest, result('unknown', 'QQ 提交意图已落盘；结果尚未确认，禁止重发', connection['accountId']))
        if not inserted:
            return value
        submitted = False

        def before_submit():
            nonlocal submitted
            # The pipe request can trigger an irreversible native send.
            submitted = True

        try:
            value = self.desktop.submit(prepared, key, params['target'], params['text'], before_submit)
            if not submitted:
                raise RuntimeError('QQ 提交实现未报告提交边界')
            value = self._finish(key, value)
            if value['state'] == 'unknown':
                self.sealed = True
            if value['state'] == 'submitted' and self.temporary is not None and connection['accountId'] == self.temporary['accountId']:
                self.temporary_ready = self.temporary_submitted = True
            return value
        except Exception as error:
            if submitted:
                self.sealed = True
                value = result('unknown', 'QQ 客户端提交结果未知，禁止重发；关闭提醒不等于撤回 QQ 工作', connection['accountId'])
            else:
                state = error.state if isinstance(error, QQGuardError) else 'failed'
                value = result(state, str(error) if isinstance(error, QQGuardError) else 'QQ 提交前操作失败，本次未提交', connection['accountId'])
            try:
                return self._finish(key, value)
            except sqlite3.Error:
                self.sealed = True
                return result('unknown', 'QQ 提交日志无法确认，持久化未决记录保持有效，禁止重发', connection['accountId'])

    def close(self, params=None):
        fields({} if params is None else params)
        if not self.closed:
            self.closed = True
            self.desktop.close()
            if self.db is not None:
                self.db.close()
        return {'closed': True}

    def dispatch(self, method, params):
        if self.closed:
            raise RequestError('QQ 工作进程已关闭')
        if method not in ('inspect', 'installation', 'beginLaunch', 'claimLaunch', 'finishBatch', 'query', 'send', 'close'):
            raise RequestError('未知 QQ 工作进程方法')
        return getattr(self, method)(params)


def strict_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise RequestError('JSON 含重复字段')
        value[key] = item
    return value


def respond(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(',', ':')) + '\n')
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(description='OMP QQ 自身设备提醒工作进程')
    parser.add_argument('--state-dir', required=True)
    args = parser.parse_args()
    worker = Worker(args.state_dir)
    try:
        while not worker.closed:
            line = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
            if not line:
                break
            if len(line) > MAX_LINE_BYTES or not line.endswith(b'\n'):
                respond({'id': None, 'error': {'message': 'NDJSON 请求超长或不完整'}})
                break
            rpc_id = None
            try:
                envelope = json.loads(line.decode('utf-8'), object_pairs_hook=strict_object,
                                      parse_constant=lambda _: (_ for _ in ()).throw(RequestError('JSON 常量无效')))
                fields(envelope, 'id', 'method', 'params')
                if type(envelope['id']) is not int or not 1 <= envelope['id'] <= 2**53 - 1:
                    raise RequestError('RPC id 无效')
                rpc_id = envelope['id']
                if not isinstance(envelope['method'], str):
                    raise RequestError('RPC method 无效')
                respond({'id': rpc_id, 'result': worker.dispatch(envelope['method'], envelope['params'])})
            except Exception as error:
                rejected = isinstance(error, RequestError)
                respond({'id': rpc_id, 'error': {
                    'code': 'invalid_request' if rejected else 'worker_failure',
                    'message': str(error) if rejected else 'QQ 工作进程操作失败；未暴露界面或聊天内容'}})
    finally:
        worker.close()


if __name__ == '__main__':
    main()
