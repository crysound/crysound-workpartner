"""Command-line add/upgrade uses the same host config directory without contacting Docker."""
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'web/bin/partner-user'


class ConfigMount(unittest.TestCase):
    def test_add_and_upgrade_keep_the_mount_and_model_environment(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = root / 'config'
            config.mkdir()
            for name in ('plugins.json', 'partner.patch.yml', 'profile-upgrades.mjs', 'plugin-patches.mjs'):
                (config / name).write_text('fixture')
            users = [{'slug': 'fake-user', 'name': 'Fake', 'unionId': 'fake-union'}]
            (root / 'users.json').write_text(json.dumps(users))
            environment = {'PARTNER_DATA': str(root), 'PARTNER_SECURE': str(root / 'secure'),
                           'PARTNER_CONFIG': str(config), 'MAGPIE_BASE_URL': 'https://models.example.invalid/v1'}
            self.enterContext(patch.dict(os.environ, environment))
            module = runpy.run_path(str(SCRIPT))
            calls = []

            def command(*args, **kwargs):
                calls.append(args)
                return subprocess.CompletedProcess(args, 1 if args[:2] == ('docker', 'inspect') else 0, '', '')

            module['container'].__globals__['sh'] = command
            module['container']('fake-user', root / 'fake.key')
            with patch('sys.argv', [str(SCRIPT), 'upgrade', 'fake-user']):
                module['main']()
            runs = [args for args in calls if args[:2] == ('docker', 'run')]
            self.assertEqual(len(runs), 2)
            for args in runs:
                self.assertIn(f'type=bind,src={config},dst=/opt/partner-config,readonly', args)
                self.assertIn('MAGPIE_BASE_URL=https://models.example.invalid/v1', args)
            calls.clear()
            (config / 'partner.patch.yml').unlink()
            with patch('sys.argv', [str(SCRIPT), 'upgrade', 'fake-user']), self.assertRaises(SystemExit):
                module['main']()
            self.assertFalse(calls, 'missing config must fail before removing the old container')


if __name__ == '__main__':
    unittest.main()
