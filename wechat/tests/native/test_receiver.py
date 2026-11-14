"""Controlled SQLite/NDJSON receiver tests. Never connects to WeChat."""
from contextlib import contextmanager
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

import psutil

BRIDGE = Path(__file__).resolve().parents[2] / 'bridge'
sys.path.insert(0, str(BRIDGE))
from receiver import Receiver, ReceiverError, content, mentions, quote, table_for, MAX_CONTENT, serve
from readonly.process import IdentityError

ACCOUNT = 'wxid_fixture_bot'
PEER = 'wxid_fixture_member'
GROUP = '10001@chatroom'
OTHER = '10002@chatroom'
UNREGISTERED = '10003@chatroom'


@contextmanager
def fixture_database(path):
    # sqlite3.Connection.__exit__ commits/rolls back, but does not close.
    connection = sqlite3.connect(path)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


class DatabaseFixture:
    def __init__(self, home, pid=None):
        self.home = Path(home)
        self.root = self.home / 'selected' / 'db_storage'
        (self.root / 'message').mkdir(parents=True)
        (self.root / 'contact').mkdir()
        self.contact = self.root / 'contact' / 'contact.db'
        self.shard = self.root / 'message' / 'message_0.db'
        self.pid = os.getpid() if pid is None else pid
        self.created = round(psutil.Process(self.pid).create_time() * 1000)
        self.binding = {'fixture': True, 'accountId': ACCOUNT, 'pid': self.pid, 'createdAtMs': self.created,
                        'contactDatabaseFiles': [str(self.contact)]}
        self.binding_path = self.home / 'binding.json'
        self.save_binding()
        with fixture_database(self.root / 'fixture-identity.sqlite') as connection:
            connection.execute('CREATE TABLE receiver_fixture_identity(account_id TEXT,pid INTEGER,created_at_ms INTEGER)')
            connection.execute('INSERT INTO receiver_fixture_identity VALUES (?,?,?)', (ACCOUNT, self.pid, self.created))
        with fixture_database(self.contact) as connection:
            connection.executescript('''
                CREATE TABLE contact(id INTEGER PRIMARY KEY,username TEXT,nick_name TEXT,remark TEXT,alias TEXT);
                CREATE TABLE chat_room(id INTEGER PRIMARY KEY,username TEXT);
                CREATE TABLE chatroom_member(room_id INTEGER,member_id INTEGER);
            ''')
            connection.executemany('INSERT INTO contact VALUES (?,?,?,?,?)',
                [(1, ACCOUNT, '机器人', '本机私密机器人备注', ''), (2, PEER, '真实成员', '本机私密成员备注', '私人别名')])
            connection.executemany('INSERT INTO chat_room VALUES (?,?)', [(1, GROUP), (2, OTHER)])
            connection.executemany('INSERT INTO chatroom_member VALUES (?,?)', [(1, 1), (1, 2), (2, 1), (2, 2)])
        self.make_shard(self.shard)

    def save_binding(self):
        self.binding_path.write_text(json.dumps(self.binding), encoding='utf-8')

    def make_shard(self, path):
        with fixture_database(path) as connection:
            connection.execute('CREATE TABLE Name2Id(user_name TEXT)')
            connection.executemany('INSERT INTO Name2Id(rowid,user_name) VALUES (?,?)', [(1, ACCOUNT), (2, PEER)])
            for target in (GROUP, OTHER, PEER, UNREGISTERED):
                connection.execute('CREATE TABLE ' + quote(table_for(target)) + '''(
                    local_id INTEGER PRIMARY KEY,local_type INTEGER,real_sender_id INTEGER,
                    create_time INTEGER,message_content BLOB,server_id INTEGER,compress_content BLOB,source BLOB)''')

    def insert(self, target=GROUP, *, local_id=None, server_id=None, text='中文🙂', sender=2,
               source=None, kind=1, compressed=None, shard=None):
        shard = Path(shard) if shard else self.shard
        with fixture_database(shard) as connection:
            table = quote(table_for(target))
            if local_id is None:
                local_id = connection.execute('SELECT COALESCE(MAX(local_id),0)+1 FROM ' + table).fetchone()[0]
            if server_id is None:
                server_id = 9007199254740991 + local_id
            if source is None:
                source = '<msgsource><atuserlist><![CDATA[' + ACCOUNT + ']]></atuserlist></msgsource>'
            connection.execute('INSERT INTO ' + table + ' VALUES (?,?,?,?,?,?,?,?)',
                (local_id, kind, sender, 1800000000 + local_id, text, server_id, compressed, source))
        return str(server_id if server_id >= 0 else server_id + (1 << 64))

    def receiver(self, **changes):
        options = dict(account_id=ACCOUNT, pid=self.pid, created_at_ms=self.created,
                       binding_path=str(self.binding_path), state_dir=str(self.home / 'state'),
                       allowed_targets=[GROUP, OTHER, PEER], allow_read=True, fixture=True)
        options.update(changes)
        return Receiver(**options)

    def command(self):
        return [sys.executable, '-B', str(BRIDGE / 'receiver.py'), '--account-id', ACCOUNT,
                '--pid', str(self.pid), '--created-at-ms', str(self.created),
                '--binding-path', str(self.binding_path), '--state-dir', str(self.home / 'state'),
                '--allowed-target', GROUP, '--allowed-target', OTHER, '--allowed-target', PEER,
                '--allow-read', '--fixture']


class ReceiverTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='omp-receiver-test-')
        self.addCleanup(self.temporary.cleanup)
        self.fixture = DatabaseFixture(self.temporary.name)

    def receiver(self, **options):
        result = self.fixture.receiver(**options)
        self.addCleanup(result.close)
        return result

    def test_disabled_never_reads_binding_or_creates_state(self):
        receiver = self.receiver(allow_read=False, binding_path=str(Path(self.temporary.name) / 'absent.json'))
        with self.assertRaises(ReceiverError) as error:
            receiver.start()
        self.assertEqual(error.exception.code, 'READ_DISABLED')
        self.assertFalse((Path(self.temporary.name) / 'state').exists())

    def test_fresh_baseline_ack_exact_batch_and_durable_restart(self):
        self.fixture.insert(text='启动前历史')
        receiver = self.receiver()
        receiver.start()
        self.assertEqual(receiver.poll(), {'batchId': None, 'events': [], 'errors': []})
        message_id = self.fixture.insert(text='刚到达的真实消息')
        batch = receiver.poll()
        self.assertEqual(batch['events'][0]['messageId'], message_id)
        self.assertEqual(batch['events'][0]['mentions'], [ACCOUNT])
        self.assertEqual(batch['events'][0]['senderId'], PEER)
        self.assertEqual(batch['events'][0]['senderName'], '群友')
        self.assertEqual(batch, receiver.poll())
        with self.assertRaises(ReceiverError):
            receiver.ack('f' * 32)
        receiver.close()
        restarted = self.receiver()
        self.assertEqual(restarted.start()['pendingBatchId'], batch['batchId'])
        self.assertEqual(restarted.poll(), batch)
        restarted.ack(batch['batchId'])
        self.assertIsNone(restarted.poll()['batchId'])
        restarted.close()
        resumed = self.receiver()
        resumed.start()
        self.assertEqual(resumed.poll()['events'], [])
        with fixture_database(Path(self.temporary.name) / 'state' / 'receiver.sqlite') as connection:
            value = connection.execute('SELECT fingerprint FROM delivered').fetchone()[0]
            self.assertEqual(len(value), 64)
            self.assertNotIn('真实消息', value)

    def test_duplicate_shards_and_signed_platform_id_stay_strings(self):
        receiver = self.receiver()
        receiver.start()
        shard2 = self.fixture.root / 'message' / 'message_1.db'
        self.fixture.make_shard(shard2)
        first = self.fixture.insert(server_id=-5)
        self.fixture.insert(server_id=-5, shard=shard2)
        batch = receiver.poll()
        self.assertEqual([event['messageId'] for event in batch['events']], [first])
        receiver.ack(batch['batchId'])
        self.fixture.insert(server_id=-5, local_id=2, shard=shard2)
        # Matching ID with a different timestamp is a conflict, never a resend.
        conflict = receiver.poll()
        self.assertEqual(conflict['events'], [])
        self.assertEqual(conflict['errors'][0]['code'], 'DUPLICATE_CONFLICT')

    def test_busy_group_yields_the_next_batch_to_another_group(self):
        receiver = self.receiver()
        receiver.start()
        for index in range(1, 9):
            self.fixture.insert(local_id=index, text='x' * (MAX_CONTENT - 512))
        self.fixture.insert(OTHER, text='不能被繁忙群饿死')
        first = receiver.poll()
        self.assertEqual({event['sessionId'] for event in first['events']}, {GROUP})
        receiver.ack(first['batchId'])
        next_batch = receiver.poll()
        self.assertEqual(next_batch['events'][0]['sessionId'], OTHER)

    def test_malformed_xml_pauses_one_group_without_advancing_it(self):
        receiver = self.receiver()
        receiver.start()
        self.fixture.insert(source='<msgsource><atuserlist>broken')
        good = self.fixture.insert(OTHER, text='另群继续')
        batch = receiver.poll()
        self.assertEqual([event['messageId'] for event in batch['events']], [good])
        self.assertEqual(batch['errors'][0]['sessionId'], GROUP)
        receiver.ack(batch['batchId'])
        with fixture_database(self.fixture.shard) as connection:
            connection.execute('UPDATE ' + quote(table_for(GROUP)) + ' SET source=?', ('<msgsource/>',))
        repaired = receiver.poll()
        self.assertEqual([event['sessionId'] for event in repaired['events']], [GROUP])
        self.assertEqual(repaired['events'][0]['mentions'], [])

    def test_invalid_mapping_and_conflicting_catalogs_do_not_guess(self):
        receiver = self.receiver()
        receiver.start()
        self.fixture.insert(sender=999)
        self.fixture.insert(OTHER, text='独立群')
        batch = receiver.poll()
        self.assertEqual([event['sessionId'] for event in batch['events']], [OTHER])
        self.assertEqual(batch['errors'][0]['code'], 'INVALID_SENDER_MAPPING')
        receiver.ack(batch['batchId'])
        with fixture_database(self.fixture.shard) as connection:
            connection.execute('CREATE TABLE SenderName2Id(user_name TEXT)')
            connection.execute('INSERT INTO SenderName2Id(rowid,user_name) VALUES (?,?)', (2, 'wxid_impostor'))
        self.fixture.insert(OTHER)
        result = receiver.poll()
        self.assertEqual(result['events'], [])
        self.assertEqual({error['sessionId'] for error in result['errors']}, {GROUP, OTHER})

    def test_missing_local_sender_uses_authenticated_global_catalog(self):
        resource = self.fixture.root / 'message' / 'message_resource.db'
        with fixture_database(self.fixture.shard) as connection:
            connection.execute('CREATE TABLE SenderName2Id(user_name TEXT)')
            connection.execute('INSERT INTO SenderName2Id(rowid,user_name) VALUES (?,?)', (1, ACCOUNT))
        with fixture_database(resource) as connection:
            connection.execute('CREATE TABLE Name2Id(user_name TEXT)')
            connection.executemany('INSERT INTO Name2Id(rowid,user_name) VALUES (?,?)',
                [(999, PEER), (2, 'wxid_wrong_global_entry')])
        receiver = self.receiver()
        receiver.start()
        expected = self.fixture.insert(sender=999, text='本地缺项使用全局真实映射')
        batch = receiver.poll()
        self.assertEqual(batch['errors'], [])
        self.assertEqual([(event['messageId'], event['senderId']) for event in batch['events']], [(expected, PEER)])
        receiver.ack(batch['batchId'])
        # One valid local hit remains authoritative when another catalog lacks
        # that row; an unrelated global entry must not replace it.
        self.fixture.insert(sender=2, text='有效本地映射不被全局覆盖')
        local = receiver.poll()
        self.assertEqual(local['errors'], [])
        self.assertEqual([event['senderId'] for event in local['events']], [PEER])

    def test_invalid_or_conflicting_local_mapping_never_uses_global_fallback(self):
        resource = self.fixture.root / 'message' / 'message_resource.db'
        with fixture_database(resource) as connection:
            connection.execute('CREATE TABLE Name2Id(user_name TEXT)')
            connection.execute('INSERT INTO Name2Id(rowid,user_name) VALUES (?,?)', (2, PEER))
        with fixture_database(self.fixture.shard) as connection:
            connection.execute('CREATE TABLE SenderName2Id(user_name TEXT)')
            connection.execute('INSERT INTO SenderName2Id(rowid,user_name) VALUES (?,?)', (2, 'wxid_conflicting_member'))
        receiver = self.receiver()
        receiver.start()
        self.fixture.insert(sender=2)
        conflict = receiver.poll()
        self.assertEqual(conflict['events'], [])
        self.assertEqual([(error['sessionId'], error['code']) for error in conflict['errors']], [(GROUP, 'INVALID_SENDER_MAPPING')])
        with fixture_database(self.fixture.shard) as connection:
            connection.execute('UPDATE Name2Id SET user_name=? WHERE rowid=2', ('invalid\x00member',))
            connection.execute('DELETE FROM SenderName2Id WHERE rowid=2')
        invalid = receiver.poll()
        self.assertEqual(invalid['events'], [])
        self.assertEqual([(error['sessionId'], error['code']) for error in invalid['errors']], [(GROUP, 'INVALID_SENDER_MAPPING')])

    def test_broken_resource_catalog_does_not_break_local_sender_mapping(self):
        receiver = self.receiver()
        receiver.start()
        (self.fixture.root / 'message' / 'message_resource.db').write_bytes(b'broken database')
        self.fixture.insert()
        result = receiver.poll()
        self.assertEqual(len(result['events']), 1)
        self.assertEqual(result['errors'], [])

    def test_wrong_account_pid_creation_and_runtime_drift_are_rejected(self):
        for key, value in [('accountId', 'wxid_wrong'), ('pid', self.fixture.pid + 100000), ('createdAtMs', self.fixture.created + 1)]:
            original = self.fixture.binding[key]
            self.fixture.binding[key] = value
            self.fixture.save_binding()
            with self.assertRaises(IdentityError):
                self.receiver().start()
            self.fixture.binding[key] = original
            self.fixture.save_binding()
        receiver = self.receiver()
        receiver.start()
        self.fixture.insert()
        receiver.poll()
        with fixture_database(self.fixture.root / 'fixture-identity.sqlite') as connection:
            connection.execute('UPDATE receiver_fixture_identity SET account_id=?', ('wxid_changed',))
        with self.assertRaises(IdentityError):
            receiver.poll()  # Even an already staged batch needs live identity.

    def test_identity_failure_records_only_source_location_without_advancing_cursor(self):
        receiver = self.receiver()
        receiver.start()
        private_body = 'PRIVATE_BODY_MUST_NOT_APPEAR_IN_DIAGNOSTIC'
        self.fixture.insert(text=private_body)
        with fixture_database(self.fixture.root / 'fixture-identity.sqlite') as connection:
            connection.execute('UPDATE receiver_fixture_identity SET account_id=?', ('wxid_changed',))
        incoming = io.BytesIO(b'{"id":"guard","method":"poll","params":{}}\n')
        outgoing = io.BytesIO()
        serve(receiver, incoming, outgoing)
        response = json.loads(outgoing.getvalue())
        self.assertEqual(response['error']['code'], 'IDENTITY_MISMATCH')
        saved = (Path(self.temporary.name) / 'state' / 'last-identity-failure.json').read_text('utf-8')
        diagnostic = json.loads(saved)
        self.assertEqual(set(diagnostic), {'code', 'method', 'atMs', 'frames'})
        self.assertEqual(diagnostic['method'], 'poll')
        self.assertTrue(any(frame['function'] == 'verify' for frame in diagnostic['frames']))
        for frame in diagnostic['frames']:
            self.assertEqual(set(frame), {'file', 'function', 'line'})
            self.assertEqual(frame['file'], Path(frame['file']).name)
            self.assertGreater(frame['line'], 0)
        self.assertNotIn(private_body, saved)
        self.assertNotIn(str(self.fixture.root), saved)
        with fixture_database(Path(self.temporary.name) / 'state' / 'receiver.sqlite') as state:
            self.assertEqual(state.execute('SELECT MAX(local_id) FROM cursors').fetchone()[0], 0)
            self.assertEqual(state.execute('SELECT count(*) FROM delivered').fetchone()[0], 0)

    def test_matching_binding_still_rejects_wrong_actual_process_creation(self):
        self.fixture.binding['createdAtMs'] += 1
        self.fixture.save_binding()
        with fixture_database(self.fixture.root / 'fixture-identity.sqlite') as connection:
            connection.execute('UPDATE receiver_fixture_identity SET created_at_ms=?', (self.fixture.created + 1,))
        with self.assertRaises(IdentityError):
            self.receiver(created_at_ms=self.fixture.created + 1).start()

    def test_self_nontext_and_unregistered_bodies_are_not_returned(self):
        receiver = self.receiver()
        receiver.start()
        self.fixture.insert(sender=1, text='自己发送')
        self.fixture.insert(kind=3, text=b'not utf8\xff')
        self.fixture.insert(UNREGISTERED, text='不允许读取')
        expected = self.fixture.insert(PEER, text='维护者私聊')
        batch = receiver.poll()
        self.assertEqual([event['messageId'] for event in batch['events']], [expected])
        self.assertEqual(batch['events'][0]['scope'], 'private')
        receiver.ack(batch['batchId'])
        self.assertEqual(receiver.poll()['events'], [])

    def test_members_are_verified_and_missing_or_broken_roster_is_an_error(self):
        receiver = self.receiver()
        receiver.start()
        members = receiver.members(GROUP)['members']
        self.assertEqual({item['userId'] for item in members}, {ACCOUNT, PEER})
        self.assertEqual(next(item['name'] for item in members if item['userId'] == PEER), '真实成员')
        with self.assertRaises(ReceiverError):
            receiver.members(UNREGISTERED)
        with fixture_database(self.fixture.contact) as connection:
            connection.execute('UPDATE chatroom_member SET member_id=404 WHERE member_id=2')
        with self.assertRaises(ReceiverError) as error:
            receiver.members(GROUP)
        self.assertEqual(error.exception.code, 'INVALID_MEMBER_MAPPING')

    def test_public_names_exclude_private_remark_alias_and_raw_identifier(self):
        receiver = self.receiver()
        receiver.start()
        result = receiver.members(GROUP)
        self.assertNotIn('私密', json.dumps(result, ensure_ascii=False))
        self.assertNotIn('私人别名', json.dumps(result, ensure_ascii=False))
        for missing_name in ('', None, PEER):
            with self.subTest(nickname=missing_name):
                with fixture_database(self.fixture.contact) as connection:
                    connection.execute('UPDATE contact SET nick_name=? WHERE username=?', (missing_name, PEER))
                member = next(item for item in receiver.members(GROUP)['members'] if item['userId'] == PEER)
                self.assertEqual(member['name'], '群友')
        self.fixture.insert(text='未提供公开昵称')
        batch = receiver.poll()
        self.assertEqual(batch['events'][0]['senderName'], '群友')
        self.assertNotEqual(batch['events'][0]['senderName'], PEER)
        # Old staged batches must not keep exposing an ID as their display name.
        with fixture_database(Path(self.temporary.name) / 'state' / 'receiver.sqlite') as connection:
            staged = json.loads(connection.execute('SELECT payload FROM staged').fetchone()[0])
            staged['events'][0]['senderName'] = PEER
            connection.execute('UPDATE staged SET payload=?', (json.dumps(staged),))
        self.assertEqual(receiver.poll(), batch)

    def test_authenticated_legacy_member_ids_and_notify_all_remain_distinct(self):
        legacy = 'legacy.user-1987'
        with fixture_database(self.fixture.shard) as connection:
            connection.execute('UPDATE Name2Id SET user_name=? WHERE rowid=2', (legacy,))
        with fixture_database(self.fixture.contact) as connection:
            connection.execute('UPDATE contact SET username=?,nick_name=? WHERE id=2', (legacy, '公开旧成员昵称'))
        receiver = self.receiver()
        receiver.start()
        self.fixture.insert(source='<msgsource><atuserlist>legacy.target,notify@all</atuserlist></msgsource>')
        batch = receiver.poll()
        self.assertEqual(batch['errors'], [])
        self.assertEqual(batch['events'][0]['senderId'], legacy)
        self.assertEqual(batch['events'][0]['mentions'], ['legacy.target', 'notify@all'])
        self.assertNotIn(ACCOUNT, batch['events'][0]['mentions'])
        self.assertIn({'userId': legacy, 'name': '公开旧成员昵称'}, receiver.members(GROUP)['members'])
        with self.assertRaises(ReceiverError):
            self.receiver(allowed_targets=[legacy])
        with fixture_database(self.fixture.contact) as connection:
            connection.execute('UPDATE contact SET username=? WHERE id=2', ('legacy\x00invalid',))
        with self.assertRaises(ReceiverError):
            receiver.members(GROUP)

    def test_default_production_path_refuses_fixture_binding(self):
        with self.assertRaises(ReceiverError) as error:
            self.receiver(fixture=False).start()
        self.assertEqual(error.exception.code, 'INVALID_CONFIGURATION')

    def test_state_has_exclusive_owner_and_close_releases_it(self):
        first = self.receiver()
        first.start()
        with self.assertRaises(ReceiverError) as error:
            self.receiver().start()
        self.assertEqual(error.exception.code, 'STATE_BUSY')
        first.close()
        self.receiver().start()

    def test_ndjson_uses_real_database_staging_and_eof_releases_handles(self):
        process = subprocess.Popen(self.fixture.command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, env={**os.environ, 'PYTHONUTF8': '1'})
        def cleanup():
            if process.poll() is None:
                process.kill()
            process.wait(timeout=10)
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()
        self.addCleanup(cleanup)
        def request(method, params=None):
            frame = {'id': method, 'method': method, 'params': params or {}}
            process.stdin.write((json.dumps(frame) + '\n').encode())
            process.stdin.flush()
            return json.loads(process.stdout.readline())
        self.assertTrue(request('start')['result']['ready'])
        self.fixture.insert(text='NDJSON真实读取')
        first = request('poll')['result']
        self.assertEqual(first['events'][0]['text'], 'NDJSON真实读取')
        self.assertEqual(request('poll')['result'], first)
        request('ack', {'batchId': first['batchId']})
        self.assertEqual(request('poll')['result']['events'], [])
        process.stdin.close()  # EOF owns full cleanup even without close RPC.
        self.assertEqual(process.wait(timeout=10), 0)
        self.assertEqual(process.stdout.read(), b'')
        process.stdout.close()
        process.stderr.close()
        resumed = self.receiver()
        resumed.start()
        self.assertEqual(resumed.poll()['events'], [])

    def test_duplicate_protocol_fields_are_rejected_without_starting(self):
        result = subprocess.run(self.fixture.command(), input=b'{"id":"a","id":"b","method":"start","params":{}}\n',
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)['error']['code'], 'INVALID_REQUEST')
        self.assertFalse((Path(self.temporary.name) / 'state').exists())


class DecodeTests(unittest.TestCase):
    def test_real_at_list_not_display_text_and_xml_boundaries(self):
        self.assertEqual(mentions('<msgsource><atuserlist><![CDATA[wxid_a,wxid_b,wxid_a]]></atuserlist></msgsource>'), ['wxid_a', 'wxid_b'])
        for source in ('<msgsource>', '<!DOCTYPE x [<!ENTITY a "x">]><x>&a;</x>',
                       '<x><atuserlist>wxid_a</atuserlist><atuserlist>wxid_b</atuserlist></x>',
                       '<x><atuserlist><nested/></atuserlist></x>', '<x><atuserlist>' + 'x' * 257 + '</atuserlist></x>'):
            with self.subTest(source=source), self.assertRaises(ReceiverError):
                mentions(source)

    def test_strict_utf8_compression_limit_and_corruption(self):
        import zstandard
        compressor = zstandard.ZstdCompressor()
        self.assertEqual(content(compressor.compress('真实压缩🙂'.encode())), '真实压缩🙂')
        self.assertEqual(mentions(compressor.compress(b'<x><atuserlist>wxid_a</atuserlist></x>')), ['wxid_a'])
        for value in (b'\xff', b'\x28\xb5\x2f\xfdbroken', compressor.compress(b'x' * (MAX_CONTENT + 1)),
                      compressor.compress(b'good') + b'trailing', b'x' * (MAX_CONTENT + 1)):
            with self.subTest(size=len(value)), self.assertRaises(ReceiverError):
                content(value)


if __name__ == '__main__':
    if len(sys.argv) in (3, 4) and sys.argv[1] == '--create-fixture':
        fixture = DatabaseFixture(sys.argv[2], int(sys.argv[3]) if len(sys.argv) == 4 else None)
        print(json.dumps({'pid': fixture.pid, 'createdAtMs': fixture.created, 'bindingPath': str(fixture.binding_path)}))
    else:
        unittest.main()
