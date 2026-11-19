"""Offline journal/ownership boundaries; never starts or injects either client."""
from contextlib import closing
from pathlib import Path
import hashlib
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
from qq_worker import Worker, RequestError
from qq_native import QQGuardError

KEY = '1234567890abcdef1234567890abcdef'
SECOND = 'abcdef1234567890abcdef1234567890'
THIRD = '11111111111111111111111111111111'
TEXT = '【OMP 等你回答】\n请选择：\n1. 继续\n2. 停止'


class DesktopBoundary:
    def __init__(self):
        self.inspections = 0
        self.preparations = 0
        self.submitted = 0
        self.submissions = []
        self.prepare_error = None
        self.on_submit = None
        self.prepared = object()
        self.owner = {'pid': 42, 'createdAtMs': 1000, 'accountId': 'qq-desktop:42:1000'}
        self.account = self.owner['accountId']
        self.existing_client = False
        self.handoff = False
        self.generation = 1000
        self.exits = []
        self.exit_error = None

    def inspect(self):
        self.inspections += 1
        return ({'state': 'ready', 'reason': None, 'accountId': self.account, 'version': '9.9.37-54395'}, dict(self.owner))

    def prepare(self, selected):
        self.preparations += 1
        if self.prepare_error:
            raise self.prepare_error
        return self.prepared

    def submit(self, prepared, key, target, text, before_submit):
        self.submitted += 1
        self.submissions.append((key, target, text))
        if self.on_submit:
            self.on_submit(before_submit)
        else:
            before_submit()
        return {'state': 'submitted', 'reason': None, 'accountId': self.account}

    def begin_launch(self):
        return None if self.existing_client else 1000

    def claim_launch(self, pid, started):
        return None if self.handoff else dict(self.owner)

    def exit_temporary(self, expected):
        self.exits.append(dict(expected))
        if self.exit_error:
            raise self.exit_error
        if expected['createdAtMs'] != self.generation:
            raise QQGuardError('QQ 进程代次变化')
        return {'state': 'not_logged_in', 'reason': 'temporary client exited', 'accountId': None, 'version': None}


    def close(self):
        pass


class QQWorkerTests(unittest.TestCase):
    def make(self):
        temporary = tempfile.TemporaryDirectory(prefix='omp-qq-journal-')
        self.addCleanup(temporary.cleanup)
        folder = Path(temporary.name)
        desktop = DesktopBoundary()
        worker = Worker(folder, desktop=desktop)
        self.addCleanup(worker.close)
        return worker, desktop, folder

    def test_unknown_is_committed_before_client_submission_and_never_replayed(self):
        worker, desktop, folder = self.make()
        def submit(before):
            with closing(sqlite3.connect(folder / 'submissions.sqlite3')) as observer:
                row = observer.execute('SELECT state,target_id FROM submissions WHERE request_id=?', (KEY,)).fetchone()
            self.assertEqual(row, ('unknown', 'self_mobile'))
            before()
            raise TimeoutError('client acknowledgement lost')
        desktop.on_submit = submit
        value = worker.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})
        self.assertEqual(value['state'], 'unknown')
        self.assertEqual(worker.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})['state'], 'unknown')
        self.assertEqual(worker.send({'requestId': SECOND, 'target': 'phone', 'text': TEXT})['state'], 'failed')
        self.assertEqual(desktop.submitted, 1)
        self.assertEqual(desktop.preparations, 1)
        worker.close()
        replacement = DesktopBoundary()
        reopened = Worker(folder, desktop=replacement)
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})['state'], 'unknown')
        self.assertEqual(replacement.inspections, 0)
        self.assertEqual(reopened.send({'requestId': THIRD, 'target': 'pad', 'text': '重启后的新问题'})['state'], 'submitted')
        self.assertEqual(replacement.submissions, [(THIRD, 'pad', '重启后的新问题')])

    def test_submitted_result_survives_restart_and_id_cannot_bind_new_text(self):
        worker, desktop, folder = self.make()
        self.assertEqual(worker.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})['state'], 'submitted')
        worker.close()
        replacement = DesktopBoundary()
        reopened = Worker(folder, desktop=replacement)
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})['state'], 'submitted')
        with self.assertRaises(RequestError):
            reopened.send({'requestId': KEY, 'target': 'phone', 'text': '不同内容'})
        self.assertEqual(replacement.inspections, 0)

    def test_pre_submission_identity_rejection_does_not_submit_or_retry(self):
        worker, desktop, _ = self.make()
        desktop.prepare_error = QQGuardError('账号已变化')
        self.assertEqual(worker.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})['state'], 'failed')
        desktop.prepare_error = None
        self.assertEqual(worker.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})['state'], 'failed')
        self.assertEqual(desktop.preparations, 1)
        self.assertEqual(desktop.submitted, 0)

    def test_failed_intent_commit_prevents_submitting(self):
        worker, desktop, _ = self.make()
        with patch.object(worker, '_record', side_effect=sqlite3.OperationalError('disk full')):
            with self.assertRaises(sqlite3.OperationalError):
                worker.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})
        self.assertEqual(desktop.submitted, 0)

    def test_lost_commit_after_client_submission_keeps_durable_unknown(self):
        worker, desktop, _ = self.make()
        with patch.object(worker, '_finish', side_effect=sqlite3.OperationalError('disk full')):
            self.assertEqual(worker.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})['state'], 'unknown')
        self.assertEqual(worker.query({'requestId': KEY, 'target': 'phone', 'text': TEXT})['state'], 'unknown')
        self.assertEqual(worker.send({'requestId': SECOND, 'target': 'phone', 'text': TEXT})['state'], 'failed')
        self.assertEqual(desktop.submitted, 1)

    def test_native_rejection_is_persisted_without_claiming_submission(self):
        worker, desktop, _ = self.make()
        self.arm(worker)
        def reject(prepared, key, target, text, before):
            before()
            return {'state': 'failed', 'reason': 'native rejected', 'accountId': desktop.account}
        desktop.submit = reject
        self.assertEqual(worker.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})['state'], 'failed')
        self.assertEqual(worker.query({'requestId': KEY, 'target': 'phone', 'text': TEXT})['state'], 'failed')
        self.assertIsNone(worker.finishBatch({}))

    def test_native_unknown_seals_the_generation_and_survives_restart(self):
        worker, desktop, folder = self.make()
        def unknown(prepared, key, target, text, before):
            before()
            return {'state': 'unknown', 'reason': 'native timeout', 'accountId': desktop.account}
        desktop.submit = unknown
        self.assertEqual(worker.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})['state'], 'unknown')
        self.assertEqual(worker.send({'requestId': SECOND, 'target': 'phone', 'text': TEXT})['state'], 'failed')
        worker.close()
        replacement = DesktopBoundary()
        reopened = Worker(folder, desktop=replacement)
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})['state'], 'unknown')
        self.assertEqual(replacement.submitted, 0)

    def test_temporary_launch_binds_first_verified_account_but_not_another_process(self):
        worker, desktop, _ = self.make()
        desktop.claim_launch = lambda pid, started: {**desktop.owner, 'accountId': None}
        self.arm(worker)
        self.assertEqual(worker.temporary['accountId'], desktop.account)
        desktop.owner['pid'] = 84
        worker.inspect({})
        self.assertIsNone(worker.temporary)

    def test_untrusted_target_and_invalid_unicode_rejected_before_desktop_access(self):
        worker, desktop, _ = self.make()
        for payload in ({'requestId': KEY, 'text': TEXT, 'target': '我的手机'},
                        {'requestId': KEY, 'target': 'both', 'text': TEXT},
                        {'requestId': KEY, 'target': 'u_arbitrary_contact', 'text': TEXT},
                        {'requestId': KEY, 'target': [], 'text': TEXT},
                        {'requestId': KEY, 'target': 'pad', 'text': TEXT, 'peerUid': 'u_arbitrary_contact'},
                        {'requestId': KEY, 'text': TEXT},
                        {'requestId': KEY, 'target': 'phone', 'text': '\ud800'},
                        {'requestId': '0' * 32, 'target': 'phone', 'text': TEXT}):
            with self.assertRaises(RequestError):
                worker.send(payload)
        self.assertEqual(desktop.inspections, 0)

    def arm(self, worker):
        self.assertEqual(worker.beginLaunch({}), {'mayLaunch': True})
        self.assertEqual(worker.claimLaunch({'pid': 42}), {'owned': True})
        self.assertEqual(worker.inspect({})['state'], 'ready')

    def test_existing_client_and_handoff_cannot_be_owned_or_exited(self):
        worker, desktop, _ = self.make()
        worker.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})
        self.assertIsNone(worker.finishBatch({}))
        desktop.existing_client = True
        self.assertEqual(worker.beginLaunch({}), {'mayLaunch': False})
        self.assertEqual(worker.claimLaunch({'pid': 42}), {'owned': False})
        self.assertIsNone(worker.finishBatch({}))
        desktop.existing_client = False
        desktop.handoff = True
        self.assertEqual(worker.beginLaunch({}), {'mayLaunch': True})
        self.assertEqual(worker.claimLaunch({'pid': 42}), {'owned': False})
        self.assertIsNone(worker.finishBatch({}))
        self.assertEqual(desktop.exits, [])

    def test_only_actual_submission_for_claimed_account_allows_one_exit(self):
        worker, desktop, _ = self.make()
        self.arm(worker)
        self.assertIsNone(worker.finishBatch({}))
        worker.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})
        self.assertEqual(worker.finishBatch({})['state'], 'not_logged_in')
        self.assertIsNone(worker.finishBatch({}))
        self.assertEqual(desktop.exits, [desktop.owner])
        self.assertEqual(worker.query({'requestId': KEY, 'target': 'phone', 'text': TEXT})['state'], 'submitted')

    def test_replayed_submitted_record_does_not_count_as_this_temporary_session_sending(self):
        worker, desktop, _ = self.make()
        worker.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})
        self.arm(worker)
        self.assertEqual(worker.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})['state'], 'submitted')
        self.assertIsNone(worker.finishBatch({}))
        self.assertEqual(desktop.exits, [])

    def test_every_non_submitted_destination_prevents_temporary_exit_after_success(self):
        for state in ('failed', 'unknown', 'not_logged_in', 'unsupported', 'multiple_accounts'):
            with self.subTest(state=state):
                worker, desktop, _ = self.make()
                self.arm(worker)
                worker.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})
                original_submit = desktop.submit
                def fail(prepared, key, target, text, before):
                    before()
                    return {'state': state, 'reason': 'destination did not submit', 'accountId': desktop.account}
                desktop.submit = fail
                self.assertEqual(worker.send({'requestId': SECOND, 'target': 'pad', 'text': TEXT})['state'], state)
                desktop.submit = original_submit
                if state != 'unknown':
                    self.assertEqual(worker.send({'requestId': THIRD, 'target': 'phone', 'text': TEXT})['state'], 'submitted')
                self.assertIsNone(worker.finishBatch({}))
                self.assertEqual(desktop.exits, [])

    def test_changed_generation_and_exit_error_keep_submission_and_never_retry(self):
        for mode in ('generation', 'exit_error'):
            with self.subTest(mode=mode):
                worker, desktop, _ = self.make()
                self.arm(worker)
                worker.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})
                if mode == 'generation':
                    desktop.generation = 2000
                else:
                    desktop.exit_error = QQGuardError('正常退出未确认')
                self.assertEqual(worker.finishBatch({})['state'], 'error')
                self.assertIsNone(worker.finishBatch({}))
                self.assertEqual(len(desktop.exits), 1)
                self.assertEqual(worker.query({'requestId': KEY, 'target': 'phone', 'text': TEXT})['state'], 'submitted')

    def test_changed_logged_in_identity_loses_claim_and_exit_rpc_rejects_caller_target(self):
        worker, desktop, _ = self.make()
        self.arm(worker)
        worker.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})
        with self.assertRaises(RequestError):
            worker.finishBatch({'pid': 42, 'createdAtMs': 1000})
        desktop.account = 'qq-desktop:84:2000'
        worker.inspect({})
        self.assertIsNone(worker.finishBatch({}))
        self.assertEqual(desktop.exits, [])

    def test_closing_worker_never_exits_even_owned_successfully_used_qq(self):
        worker, desktop, _ = self.make()
        self.arm(worker)
        worker.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})
        self.assertEqual(worker.close(), {'closed': True})
        self.assertEqual(desktop.exits, [])

    def test_phone_and_pad_remain_distinct_and_same_id_cannot_change_target_or_text(self):
        worker, desktop, folder = self.make()
        phone = {'requestId': KEY, 'target': 'phone', 'text': TEXT}
        pad = {'requestId': SECOND, 'target': 'pad', 'text': TEXT}
        self.assertEqual(worker.send(phone)['state'], 'submitted')
        self.assertEqual(worker.send(pad)['state'], 'submitted')
        self.assertEqual(worker.query(pad)['state'], 'submitted')
        self.assertEqual(desktop.submissions, [(KEY, 'phone', TEXT), (SECOND, 'pad', TEXT)])
        for operation in (worker.query, worker.send):
            for changed in ({**phone, 'target': 'pad'}, {**pad, 'target': 'phone'}, {**pad, 'text': '另一问题'}):
                with self.assertRaises(RequestError):
                    operation(changed)
        with closing(sqlite3.connect(folder / 'submissions.sqlite3')) as observer:
            targets = dict(observer.execute('SELECT request_id,target_id FROM submissions'))
        self.assertEqual(targets, {KEY: 'self_mobile', SECOND: 'self_pad'})
        self.assertEqual(desktop.submitted, 2)

    def test_pad_lost_reply_keeps_unknown_bound_across_queries_and_restart(self):
        worker, desktop, folder = self.make()
        self.arm(worker)
        def lose_reply(before):
            with closing(sqlite3.connect(folder / 'submissions.sqlite3')) as observer:
                self.assertEqual(observer.execute('SELECT state,target_id FROM submissions').fetchone(), ('unknown', 'self_pad'))
            before()
            raise TimeoutError('Pad native reply lost')
        desktop.on_submit = lose_reply
        params = {'requestId': KEY, 'target': 'pad', 'text': TEXT}
        self.assertEqual(worker.send(params)['state'], 'unknown')
        self.assertEqual(worker.query(params)['state'], 'unknown')
        for operation in (worker.query, worker.send):
            with self.assertRaises(RequestError):
                operation({**params, 'target': 'phone'})
            with self.assertRaises(RequestError):
                operation({**params, 'text': '替换文本'})
        self.assertEqual(worker.send({'requestId': SECOND, 'target': 'phone', 'text': TEXT})['state'], 'failed')
        self.assertIsNone(worker.finishBatch({}))
        self.assertEqual(desktop.submissions, [(KEY, 'pad', TEXT)])
        worker.close()
        replacement = DesktopBoundary()
        reopened = Worker(folder, desktop=replacement)
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.send(params)['state'], 'unknown')
        self.assertEqual(replacement.submitted, 0)
        self.assertEqual(reopened.send({'requestId': THIRD, 'target': 'phone', 'text': '新问题'})['state'], 'submitted')
        self.assertEqual(replacement.submissions, [(THIRD, 'phone', '新问题')])

    def test_invalid_destination_after_success_keeps_temporary_client_open(self):
        worker, desktop, _ = self.make()
        self.arm(worker)
        worker.send({'requestId': KEY, 'target': 'phone', 'text': TEXT})
        with self.assertRaises(RequestError):
            worker.send({'requestId': SECOND, 'target': 'other-contact', 'text': TEXT})
        worker.send({'requestId': THIRD, 'target': 'pad', 'text': TEXT})
        self.assertIsNone(worker.finishBatch({}))
        self.assertEqual(desktop.exits, [])

    def legacy_journal(self, folder):
        states = ('submitted', 'not_logged_in', 'unsupported', 'multiple_accounts', 'failed', 'unknown')
        digest = hashlib.sha256(TEXT.encode('utf-8')).hexdigest()
        rows = [(f'{index + 1:032x}', digest, 'self_mobile', f'u_legacy_{index}',
                 state, f'preserved {state}', f'2026-11-{index + 1:02d} 01:02:03')
                for index, state in enumerate(states)]
        with closing(sqlite3.connect(folder / 'submissions.sqlite3')) as db:
            db.execute('''CREATE TABLE submissions (
                request_id TEXT PRIMARY KEY, payload_sha256 TEXT NOT NULL,
                target_id TEXT NOT NULL CHECK(target_id='self_mobile'), account_id TEXT,
                state TEXT NOT NULL CHECK(state IN
                    ('submitted','not_logged_in','unsupported','multiple_accounts','failed','unknown')),
                reason TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)''')
            db.executemany('INSERT INTO submissions VALUES (?,?,?,?,?,?,?)', rows)
            db.commit()
        return rows

    def test_legacy_migration_retains_every_outcome_identity_and_timestamp_without_replay(self):
        worker, desktop, folder = self.make()
        before = self.legacy_journal(folder)
        for row in before:
            params = {'requestId': row[0], 'target': 'phone', 'text': TEXT}
            expected = {'state': row[4], 'reason': row[5], 'accountId': row[3]}
            self.assertEqual(worker.query(params), {'found': True, **expected})
            self.assertEqual(worker.send(params), expected)
            for operation in (worker.query, worker.send):
                with self.assertRaises(RequestError):
                    operation({**params, 'target': 'pad'})
                with self.assertRaises(RequestError):
                    operation({**params, 'text': '不能替换历史内容'})
        self.assertEqual(desktop.inspections, 0)
        with closing(sqlite3.connect(folder / 'submissions.sqlite3')) as observer:
            self.assertEqual(observer.execute('SELECT * FROM submissions ORDER BY request_id').fetchall(), before)
            self.assertEqual(observer.execute('PRAGMA user_version').fetchone(), (2,))
        self.assertEqual(worker.send({'requestId': KEY, 'target': 'pad', 'text': TEXT})['state'], 'submitted')
        self.assertEqual(desktop.submissions, [(KEY, 'pad', TEXT)])

    def test_interrupted_legacy_migration_rolls_back_before_any_desktop_access(self):
        worker, desktop, folder = self.make()
        before = self.legacy_journal(folder)
        connect = sqlite3.connect
        def deny_table_drop(*args, **kwargs):
            db = connect(*args, **kwargs)
            db.set_authorizer(lambda action, *_: sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_DROP_TABLE else sqlite3.SQLITE_OK)
            return db
        params = {'requestId': before[0][0], 'target': 'phone', 'text': TEXT}
        with patch('qq_worker.sqlite3.connect', side_effect=deny_table_drop):
            with self.assertRaises(sqlite3.DatabaseError):
                worker.query(params)
        with closing(connect(folder / 'submissions.sqlite3')) as observer:
            self.assertEqual(observer.execute('SELECT * FROM submissions ORDER BY request_id').fetchall(), before)
            self.assertEqual(observer.execute('PRAGMA user_version').fetchone(), (0,))
            self.assertEqual(observer.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall(), [('submissions',)])
        self.assertEqual(desktop.inspections, 0)
        self.assertEqual(worker.query(params)['state'], 'submitted')
        self.assertEqual(worker.send({'requestId': KEY, 'target': 'pad', 'text': TEXT})['state'], 'submitted')


if __name__ == '__main__':
    unittest.main(verbosity=2)
