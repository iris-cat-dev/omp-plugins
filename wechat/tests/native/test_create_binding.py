"""Offline tests for explicit binding creation; no WeChat process is opened."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'bridge'))
import create_binding


class BindingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.contact = self.root / 'selected' / 'db_storage' / 'contact' / 'contact.db'
        self.contact.parent.mkdir(parents=True)
        self.contact.touch()
        self.output = self.root / 'binding.json'
        self.options = ('wxid_fixture', 123, str(self.contact), str(self.output))

    def test_explicit_authorization_is_required_before_opening_process(self):
        with patch.object(create_binding.psutil, 'Process') as process:
            with self.assertRaises(ValueError):
                create_binding.create_binding(*self.options)
            process.assert_not_called()
        self.assertFalse(self.output.exists())

    def test_only_selected_database_is_authenticated_and_no_keys_are_saved(self):
        with patch.object(create_binding.psutil, 'Process') as ps, \
             patch.object(create_binding, 'SelectedProcess') as selected:
            ps.return_value.create_time.return_value = 1234.5
            selected.return_value.keys.return_value = {self.contact: b'secret'}
            result = create_binding.create_binding(*self.options, allow_read=True)
            selected.assert_called_once_with('wxid_fixture', 123, 1234500)
            selected.return_value.keys.assert_called_once_with([self.contact])
            selected.return_value.verify.assert_called_once_with()
            selected.return_value.close.assert_called_once_with()
        self.assertEqual(json.loads(self.output.read_text(encoding='utf-8')), result)
        self.assertEqual(set(result), {'accountId', 'pid', 'createdAtMs', 'contactDatabaseFiles'})
        self.assertEqual(result['contactDatabaseFiles'], [str(self.contact)])
        self.assertNotIn('secret', self.output.read_text(encoding='utf-8'))

    def test_rejects_wrong_key_and_never_overwrites_existing_binding(self):
        with patch.object(create_binding.psutil, 'Process') as ps, \
             patch.object(create_binding, 'SelectedProcess') as selected:
            ps.return_value.create_time.return_value = 1234.5
            selected.return_value.keys.return_value = {}
            with self.assertRaises(ValueError):
                create_binding.create_binding(*self.options, allow_read=True)
            self.assertFalse(self.output.exists())
            selected.return_value.keys.return_value = {self.contact: b'secret'}
            self.output.write_text('existing', encoding='utf-8')
            with self.assertRaises(FileExistsError):
                create_binding.create_binding(*self.options, allow_read=True)
            self.assertEqual(self.output.read_text(encoding='utf-8'), 'existing')


if __name__ == '__main__':
    unittest.main()
