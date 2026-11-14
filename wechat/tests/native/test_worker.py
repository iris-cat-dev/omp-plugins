"""Isolated state/media/protocol regressions; no WeChat process is opened."""
from contextlib import closing
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
import psutil

PROJECT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT / 'bridge'))
import sender
import worker

ACCOUNT = 'wxid_isolated_test'
TARGET = '123456@chatroom'
OTHER = 'wxid_other_target'


class RecordingTransport:
    """Fault injection only at the irreversible boundary; persistence remains real."""
    profile = {'version': '1.2.3.4'}

    def __init__(self, database, result='accepted'):
        self.database, self.result = database, result
        self.calls = []
        self.closed = False
        self.identity_error = False

    def verify_identity(self):
        if self.identity_error:
            raise sender.BridgeError('identity_mismatch', 'fixture switched account')

    def send(self, target, kind, value):
        with closing(sqlite3.connect(self.database)) as connection:
            rows = connection.execute("SELECT status,owner_pid,owner_created_at_ms FROM submissions WHERE status='unknown' AND reviewed=0").fetchall()
        if len(rows) != 1 or rows[0][0] != 'unknown' or rows[0][1] != os.getpid() or rows[0][2] <= 0:
            raise AssertionError('unknown must be externally visible before entering send')
        self.calls.append((target, kind, value))
        if self.result == 'timeout':
            raise TimeoutError('isolated native boundary timeout')
        if self.result == 'truncated':
            return {'status': 0}
        if self.result == 'crash':
            raise SystemExit(71)
        return {'status': 0, 'stage': 2 if kind == 1 else 4}

    def close(self):
        self.closed = True


def write_pe(path, *, timestamp=1234, executable=True):
    data = bytearray(1536)
    data[:2] = b'MZ'
    struct.pack_into('<I', data, 60, 128)
    data[128:132] = b'PE\0\0'
    struct.pack_into('<HHIIIHH', data, 132, 0x8664, 1, timestamp, 0, 0, 240, 0x2022)
    struct.pack_into('<H', data, 152, 0x20b)
    struct.pack_into('<II', data, 208, 0x3000, 512)
    section = 392
    data[section:section + 8] = b'.text\0\0\0'
    struct.pack_into('<IIII', data, section + 8, 1024, 0x1000, 1024, 512)
    struct.pack_into('<I', data, section + 36, 0x40000040 | (0x20000000 if executable else 0))
    path.write_bytes(data)
    return data


class HostTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.media = self.root / 'input'
        self.media.mkdir()
        self.state = self.root / 'state'
        self.hosts = []

    def tearDown(self):
        for host in reversed(self.hosts):
            host.close({})
        self.temporary.cleanup()

    def host(self, *, allow_native=False, state=None):
        host = worker.Worker(ACCOUNT, state or self.state, self.media, self.root / 'engine', allow_native=allow_native)
        self.hosts.append(host)
        return host

    def attach(self, host, result='accepted'):
        transport = RecordingTransport(host.state_dir / 'state.sqlite3', result)
        host.native = transport
        host.targets = frozenset({TARGET})
        return transport

    def error(self, host, method, params, expected):
        with self.assertRaises(sender.BridgeError) as caught:
            host.dispatch(method, params)
        self.assertEqual(caught.exception.code, expected)
        return caught.exception

    def image(self, name='input.jpg'):
        path = self.media / name
        with Image.new('RGB', (13, 9), (40, 80, 120)) as image:
            image.save(path)
        return path

    @unittest.skipUnless(os.name == 'nt', 'Windows extended-length image path')
    def test_long_generated_image_path_prepares_a_bound_snapshot(self):
        import shutil
        long_root = self.media / ('a' * 64)
        directory = long_root / 'model-peers' / ('p' * 64) / 'image-tasks' / ('t' * 64) / 'media'
        source = directory / 'image.png'
        self.assertGreater(len(str(source)), 260)
        extended_root = Path('\\\\?\\' + str(long_root))
        extended_directory = Path('\\\\?\\' + str(directory))
        extended_directory.mkdir(parents=True)
        try:
            extended_source = Path('\\\\?\\' + str(source))
            with Image.new('RGBA', (23, 17), (20, 70, 110, 150)) as image:
                image.save(extended_source, format='PNG')
            host = self.host()
            asset = host.prepare_image({'targetId': TARGET, 'path': str(source)})
            self.assertEqual((asset['width'], asset['height']), (23, 17))
            snapshot = host.snapshots / f"{asset['assetId']}.png"
            with Image.open(snapshot) as image:
                self.assertEqual(image.size, (23, 17))
                self.assertEqual(image.getpixel((0, 0)), (20, 70, 110, 150))
            row = host.db.execute('SELECT account_id,target_id FROM assets WHERE asset_id=?', (asset['assetId'],)).fetchone()
            self.assertEqual((row['account_id'], row['target_id']), (ACCOUNT, TARGET))
        finally:
            shutil.rmtree(extended_root)

    def text(self, key='1234abcd1234abcd1234abcd1234abcd', target=TARGET, text='中文🙂'):
        return {'requestId': key, 'targetId': target, 'text': text}

    def test_request_id_requires_exactly_32_lowercase_hex_characters(self):
        host = self.host()
        for key in ('1234abcd', '0' * 32, 'a' * 31, 'a' * 33, 'A' * 32, 'g' * 32):
            error = self.error(host, 'submit_text', self.text(key=key), 'invalid_params')
            self.assertIsNone(error.request_id)
            self.error(host, 'submission', {'requestId': key}, 'invalid_params')
        self.assertEqual(worker.request_id('a' * 32), 'a' * 32)

    def test_default_offline_never_constructs_native_or_queries_process(self):
        with patch.object(sender, 'NativeSender', side_effect=AssertionError('native constructed')), patch.object(psutil, 'Process', side_effect=AssertionError('process opened')):
            host = self.host()
            self.assertFalse(host.status({})['nativeAllowed'])
            self.error(host, 'connect', {'processId': os.getpid(), 'processCreatedAtMs': 1, 'targets': [TARGET]}, 'native_disabled')
            error = self.error(host, 'submit_text', self.text(), 'native_disabled')
            self.assertEqual(error.outcome, 'not_submitted')
            self.assertEqual(host.submission({'requestId': '1234abcd1234abcd1234abcd1234abcd'}), {'found': False})
            self.error(host, 'acknowledge', {'requestId': '1234abcd1234abcd1234abcd1234abcd', 'resolution': 'checked_no_retry'}, 'native_disabled')
            self.assertEqual(host.disconnect({}), {'connected': False})

    def test_state_cannot_be_rebound_to_another_account(self):
        host = self.host()
        with self.assertRaises(sender.BridgeError) as caught:
            worker.Worker('wxid_other_account', self.state, self.media, self.root / 'engine')
        self.assertEqual(caught.exception.code, 'account_mismatch')
        self.assertEqual(host.db.execute("SELECT value FROM metadata WHERE key='account_id'").fetchone()[0], ACCOUNT)

    def test_png_snapshot_survives_source_changes_and_restart(self):
        host = self.host()
        source = self.image()
        result = host.prepare_image({'targetId': TARGET, 'path': str(source)})
        snapshot = self.state / 'media' / (result['assetId'] + '.png')
        png = snapshot.read_bytes()
        self.assertEqual(hashlib.sha256(png).hexdigest(), result['sha256'])
        with Image.open(snapshot) as image:
            self.assertEqual(image.format, 'PNG')
            self.assertEqual(image.size, (13, 9))
        source.write_bytes(b'changed source')
        self.assertEqual(snapshot.read_bytes(), png)
        host.close({})
        reopened = self.host()
        self.assertEqual(reopened.status({})['preparedImages'], 1)
        self.error(reopened, 'submit_image', {'requestId': '1234abcd1234abcd1234abcd1234abcd', 'targetId': OTHER, 'assetId': result['assetId']}, 'asset_mismatch')
        self.error(reopened, 'submit_image', {'requestId': '1234abcd1234abcd1234abcd1234abcd', 'targetId': TARGET, 'assetId': result['assetId']}, 'native_disabled')

    def test_rejects_root_escape_corrupt_input_and_size_bombs(self):
        host = self.host()
        outside = self.root / 'outside.png'
        with Image.new('RGB', (1, 1)) as image:
            image.save(outside)
        self.error(host, 'prepare_image', {'targetId': TARGET, 'path': str(outside)}, 'path_not_allowed')
        corrupt = self.media / 'corrupt.png'
        corrupt.write_bytes(b'not an image')
        self.error(host, 'prepare_image', {'targetId': TARGET, 'path': str(corrupt)}, 'invalid_image')
        source = self.image()
        with patch.object(worker, 'MAX_IMAGE_BYTES', 5):
            self.error(host, 'prepare_image', {'targetId': TARGET, 'path': str(source)}, 'invalid_image')
        with patch.object(worker, 'MAX_IMAGE_PIXELS', 100):
            self.error(host, 'prepare_image', {'targetId': TARGET, 'path': str(source)}, 'invalid_image')
        self.assertEqual(host.status({})['preparedImages'], 0)

    def test_link_or_junction_escape_is_rejected(self):
        host = self.host()
        outside = self.root / 'outside.png'
        with Image.new('RGB', (1, 1)) as image:
            image.save(outside)
        link = self.media / 'link.png'
        try:
            link.symlink_to(outside)
        except OSError:
            if os.name != 'nt':
                self.skipTest('symlink creation not permitted on this machine')
            import _winapi
            junction = self.media / 'linked-directory'
            try:
                _winapi.CreateJunction(str(self.root), str(junction))
            except OSError:
                self.skipTest('neither symlinks nor junctions are permitted on this machine')
            link = junction / outside.name
        self.error(host, 'prepare_image', {'targetId': TARGET, 'path': str(link)}, 'path_not_allowed')

    def test_durable_submission_replay_conflict_and_offline_history(self):
        host = self.host(allow_native=True)
        native = self.attach(host)
        first = host.dispatch('submit_text', self.text())
        self.assertEqual(first['status'], 'submitted')
        self.assertEqual(host.dispatch('submit_text', self.text()), first)
        self.assertEqual(len(native.calls), 1)
        for changed in (self.text(text='different'), self.text(target=OTHER)):
            error = self.error(host, 'submit_text', changed, 'conflict')
            self.assertIsNone(error.outcome)
        host.disconnect({})
        host.allow_native = False
        self.assertEqual(host.dispatch('submit_text', self.text()), first)
        self.assertEqual(host.submission({'requestId': '1234abcd1234abcd1234abcd1234abcd'})['status'], 'submitted')

    def test_selected_target_and_account_gate_precede_unknown_record(self):
        host = self.host(allow_native=True)
        native = self.attach(host)
        self.error(host, 'submit_text', self.text(target=OTHER), 'target_not_allowed')
        native.identity_error = True
        self.error(host, 'submit_text', self.text(), 'identity_mismatch')
        self.assertEqual(native.calls, [])
        self.assertEqual(host.submission({'requestId': '1234abcd1234abcd1234abcd1234abcd'}), {'found': False})

    def test_snapshot_tamper_and_cross_account_asset_are_rejected(self):
        host = self.host(allow_native=True)
        native = self.attach(host)
        asset = host.prepare_image({'targetId': TARGET, 'path': str(self.image())})
        params = {'requestId': '1234abcd1234abcd1234abcd1234abcd', 'targetId': TARGET, 'assetId': asset['assetId']}
        host.db.execute('UPDATE assets SET account_id=? WHERE asset_id=?', ('wxid_unrelated', asset['assetId']))
        self.error(host, 'submit_image', params, 'asset_mismatch')
        host.db.execute('UPDATE assets SET account_id=? WHERE asset_id=?', (ACCOUNT, asset['assetId']))
        snapshot = self.state / 'media' / (asset['assetId'] + '.png')
        snapshot.write_bytes(b'tampered')
        self.error(host, 'submit_image', params, 'asset_changed')
        self.assertEqual(native.calls, [])
        self.assertEqual(host.status({})['unknownCount'], 0)

    def test_image_identity_is_snapshot_digest_not_asset_id(self):
        host = self.host(allow_native=True)
        native = self.attach(host)
        source = self.image()
        one = host.prepare_image({'targetId': TARGET, 'path': str(source)})
        two = host.prepare_image({'targetId': TARGET, 'path': str(source)})
        params = {'requestId': '1234abcd1234abcd1234abcd1234abcd', 'targetId': TARGET, 'assetId': one['assetId']}
        result = host.dispatch('submit_image', params)
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(host.dispatch('submit_image', {**params, 'assetId': two['assetId']}), result)
        self.assertEqual(len(native.calls), 1)
        self.error(host, 'submit_text', self.text(), 'conflict')

    def test_unknown_blocks_and_survives_disconnect_and_reopen(self):
        host = self.host(allow_native=True)
        native = self.attach(host, 'timeout')
        first = host.dispatch('submit_text', self.text())
        self.assertEqual(first, {'requestId': '1234abcd1234abcd1234abcd1234abcd', 'status': 'unknown', 'reviewed': False})
        self.assertEqual(host.dispatch('submit_text', self.text()), first)
        self.assertEqual(len(native.calls), 1)
        self.error(host, 'submit_text', self.text(key='1234abcd1234abcd1234abcd1234abce'), 'restart_required')
        self.error(host, 'submit_text', self.text(text='different'), 'conflict')
        self.error(host, 'acknowledge', {'requestId': '1234abcd1234abcd1234abcd1234abcd', 'resolution': 'checked_no_retry'}, 'owner_alive')
        host.disconnect({})
        self.assertTrue(native.closed)
        host.close({})
        reopened = self.host(allow_native=True)
        self.attach(reopened)
        self.assertEqual(reopened.status({})['unknownCount'], 1)
        self.error(reopened, 'submit_text', self.text(key='1234abcd1234abcd1234abcd1234abce'), 'review_required')
        self.assertEqual(reopened.dispatch('submit_text', self.text()), first)

    def test_unknown_image_keeps_snapshot_and_original_binding(self):
        host = self.host(allow_native=True)
        native = self.attach(host, 'timeout')
        source = self.image()
        asset = host.prepare_image({'targetId': TARGET, 'path': str(source)})
        params = {'requestId': '1234abcd1234abcd1234abcd1234abcd', 'targetId': TARGET, 'assetId': asset['assetId']}
        first = host.dispatch('submit_image', params)
        self.assertEqual(first['status'], 'unknown')
        source.unlink()
        snapshot = self.state / 'media' / (asset['assetId'] + '.png')
        self.assertEqual(sender.digest_file(snapshot), asset['sha256'])
        self.error(host, 'submit_image', {**params, 'targetId': OTHER}, 'conflict')
        host.close({})
        reopened = self.host()
        self.assertEqual(reopened.dispatch('submit_image', params), first)
        self.assertEqual(sender.digest_file(snapshot), asset['sha256'])
        self.assertEqual(len(native.calls), 1)

    def test_truncated_native_result_and_crash_stay_unknown(self):
        for index, failure in enumerate(('truncated', 'crash')):
            host = self.host(allow_native=True, state=self.root / f'state-{index}')
            self.attach(host, failure)
            if failure == 'crash':
                with self.assertRaises(SystemExit):
                    host.dispatch('submit_text', self.text())
            else:
                self.assertEqual(host.dispatch('submit_text', self.text())['status'], 'unknown')
            self.assertEqual(host.submission({'requestId': '1234abcd1234abcd1234abcd1234abcd'})['status'], 'unknown')

    def test_failed_durable_insert_never_enters_native_send(self):
        host = self.host(allow_native=True)
        native = self.attach(host)
        host.db.execute("CREATE TRIGGER deny_submission BEFORE INSERT ON submissions BEGIN SELECT RAISE(ABORT, 'fixture disk write denied'); END")
        self.error(host, 'submit_text', self.text(), 'operation_failed')
        self.assertEqual(native.calls, [])
        self.assertEqual(host.submission({'requestId': '1234abcd1234abcd1234abcd1234abcd'}), {'found': False})

    def test_failed_acceptance_write_preserves_unknown_and_never_replays(self):
        host = self.host(allow_native=True)
        native = self.attach(host)
        host.db.execute("CREATE TRIGGER deny_acceptance BEFORE UPDATE OF status ON submissions BEGIN SELECT RAISE(ABORT, 'fixture accepted write denied'); END")
        result = host.dispatch('submit_text', self.text())
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(host.submission({'requestId': '1234abcd1234abcd1234abcd1234abcd'})['status'], 'unknown')
        self.assertEqual(host.dispatch('submit_text', self.text()), result)
        self.assertEqual(len(native.calls), 1)
        self.error(host, 'submit_text', self.text(key='1234abcd1234abcd1234abcd1234abce'), 'restart_required')

    def test_ack_requires_old_host_exit_preserves_unknown_and_only_enables_new_keys(self):
        child = subprocess.Popen([sys.executable, '-B', str(Path(__file__).with_name('unknown_host.py')),
                                  str(self.state), str(self.media)], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8',
                                 env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
        try:
            ready = json.loads(child.stdout.readline())
            self.assertEqual(ready['status'], 'unknown')
            host = self.host(allow_native=True)
            native = self.attach(host)
            self.error(host, 'acknowledge', {'requestId': '1234abcd1234abcd1234abcd1234abcd', 'resolution': 'checked_no_retry'}, 'owner_alive')
            child.communicate('\n', timeout=10)
            self.assertEqual(child.returncode, 0)
            acknowledged = host.acknowledge({'requestId': '1234abcd1234abcd1234abcd1234abcd', 'resolution': 'checked_no_retry'})
            self.assertEqual(acknowledged, {'requestId': '1234abcd1234abcd1234abcd1234abcd', 'status': 'unknown', 'reviewed': True})
            self.assertEqual(host.status({})['unknownCount'], 0)
            self.assertEqual(host.dispatch('submit_text', self.text()), acknowledged)
            self.assertEqual(native.calls, [])
            self.assertEqual(host.dispatch('submit_text', self.text(key='1234abcd1234abcd1234abcd1234abce'))['status'], 'submitted')
            self.assertEqual(len(native.calls), 1)
            self.assertEqual(host.submission({'requestId': '1234abcd1234abcd1234abcd1234abcd'})['status'], 'unknown')
            self.assertTrue((self.state / 'media' / ready['snapshot']).is_file())
        finally:
            if child.poll() is None:
                child.communicate('\n', timeout=10)

    def test_pid_reuse_is_distinguished_by_creation_time(self):
        created = round(psutil.Process(os.getpid()).create_time() * 1000)
        self.assertTrue(worker.owner_alive(os.getpid(), created))
        self.assertFalse(worker.owner_alive(os.getpid(), created - 10000))

    def test_ndjson_rejects_duplicates_nonfinite_bounds_and_incomplete_input(self):
        cases = [b'{"id":"a","id":"b","method":"status","params":{}}\n',
                 b'{"id":"a","method":"status","params":{"x":NaN}}\n',
                 b'{"id":"a","method":"status","params":{"x":1e999}}\n',
                 b'{"id":"a","method":"status","params":{}}',
                 b'x' * (worker.MAX_LINE_BYTES + 1) + b'\n',
                 b'\xff\n']
        for index, frame in enumerate(cases):
            host = self.host(state=self.root / f'protocol-{index}')
            output = io.BytesIO()
            worker.serve(host, io.BytesIO(frame), output)
            response = json.loads(output.getvalue())
            self.assertEqual(response['error']['code'], 'invalid_request')
            self.assertTrue(host.closed)

    def test_eof_and_close_release_only_owned_transport(self):
        for index, frame in enumerate((b'', b'{"id":"bye","method":"close","params":{}}\n')):
            host = self.host(state=self.root / f'eof-{index}')
            native = self.attach(host)
            output = io.BytesIO()
            worker.serve(host, io.BytesIO(frame), output)
            self.assertTrue(host.closed)
            self.assertTrue(native.closed)
            if frame:
                self.assertEqual(json.loads(output.getvalue()), {'id': 'bye', 'result': {'closed': True}})


class StaticNativeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / 'bridge.cpp'
        self.source.write_bytes(b'isolated build source fingerprint fixture\n')
        self.profiles = self.root / 'profiles.json'
        self.module = self.root / 'Weixin.dll'
        write_pe(self.module)
        self.profile = {'version': '1.2.3.4', 'size': self.module.stat().st_size,
                        'sha256': sender.digest_file(self.module), 'timestamp': 1234, 'imageSize': 0x3000,
                        'addresses': {name: 0x1000 + index * 8 for index, name in enumerate(sender.CALLS)}}
        self.profiles.write_text(json.dumps([self.profile]), encoding='utf-8')
        self.engine = self.root / 'engine'
        self.engine.mkdir()
        self.dll = self.engine / 'omp-wechat-send.dll'
        write_pe(self.dll, timestamp=9876)
        self.build = {'file': str(self.dll), 'sha256': sender.digest_file(self.dll), 'sourceSha256': sender.digest_file(self.source)}
        (self.engine / 'current.json').write_text(json.dumps(self.build), encoding='utf-8')
        self.source_patch = patch.object(sender, 'SOURCE', self.source)
        self.profiles_patch = patch.object(sender, 'PROFILES', self.profiles)
        self.source_patch.start()
        self.profiles_patch.start()

    def tearDown(self):
        self.source_patch.stop()
        self.profiles_patch.stop()
        self.temporary.cleanup()

    def test_static_inspection_validates_pe_fingerprint_and_build_without_loading(self):
        with patch.object(sender, 'NativeSender', side_effect=AssertionError('native constructed')):
            result = sender.inspect(self.engine, str(self.module))
        self.assertEqual(result['requestSize'], 4464)
        self.assertEqual(result['callCount'], 19)
        self.assertTrue(result['fileFingerprintMatched'])
        self.assertEqual(result['version'], '1.2.3.4')
        self.source.write_bytes(b'changed source')
        with self.assertRaises(sender.BridgeError) as caught:
            sender.inspect(self.engine)
        self.assertEqual(caught.exception.code, 'invalid_build')

    def test_build_must_stay_under_engine_directory(self):
        self.build['file'] = str(self.module)
        (self.engine / 'current.json').write_text(json.dumps(self.build), encoding='utf-8')
        with self.assertRaises(sender.BridgeError) as caught:
            sender.current_build(self.engine)
        self.assertEqual(caught.exception.code, 'invalid_build')

    def test_portable_relative_build_preserves_fingerprint_and_root_boundary(self):
        self.build['file'] = self.dll.name
        (self.engine / 'current.json').write_text(json.dumps(self.build), encoding='utf-8')
        self.assertEqual(sender.current_build(self.engine)['file'], str(self.dll.resolve()))
        outside = self.root / 'outside' / 'omp-wechat-send.dll'
        outside.parent.mkdir()
        outside.write_bytes(self.dll.read_bytes())
        self.build['file'] = '../outside/omp-wechat-send.dll'
        self.build['sha256'] = sender.digest_file(outside)
        (self.engine / 'current.json').write_text(json.dumps(self.build), encoding='utf-8')
        with self.assertRaises(sender.BridgeError) as caught:
            sender.current_build(self.engine)
        self.assertEqual(caught.exception.code, 'invalid_build')

    def test_file_and_profile_range_mismatches_are_rejected(self):
        self.module.write_bytes(self.module.read_bytes() + b'changed')
        with self.assertRaises(sender.BridgeError) as caught:
            sender.select_profile(self.module, [self.profile])
        self.assertEqual(caught.exception.code, 'unsupported_build')
        write_pe(self.module, executable=False)
        self.profile['sha256'] = sender.digest_file(self.module)
        with self.assertRaises(sender.BridgeError) as caught:
            sender.select_profile(self.module, [self.profile])
        self.assertEqual(caught.exception.code, 'invalid_pe')
        self.profile['addresses']['text'] = self.profile['imageSize']
        self.profiles.write_text(json.dumps([self.profile]), encoding='utf-8')
        with self.assertRaises(sender.BridgeError) as caught:
            sender.load_profiles()
        self.assertEqual(caught.exception.code, 'invalid_profile')

    def test_request_abi_and_unicode_bounds(self):
        request = sender.encode_request(self.profile, os.getpid(), ACCOUNT, TARGET, 1, '中文🙂')
        self.assertEqual(ctypes.sizeof(request), 4464)
        self.assertEqual(request.value.decode('utf-8'), '中文🙂')
        self.assertEqual(request.ownerPid, os.getpid())
        for text in ('x\0y', 'x' * 4095, '\ud800'):
            with self.assertRaises(sender.BridgeError):
                sender.encode_request(self.profile, os.getpid(), ACCOUNT, TARGET, 1, text)
        for target in ('昵称', 'someone', '../wxid_target'):
            with self.assertRaises(sender.BridgeError):
                sender.encode_request(self.profile, os.getpid(), ACCOUNT, target, 1, 'text')


if __name__ == '__main__':
    unittest.main()
