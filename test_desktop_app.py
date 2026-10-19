import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import desktop_app as app


class DesktopTests(unittest.TestCase):
    def test_config_is_local_by_default_and_preserves_options(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'config.json'
            config=app.load_config(p)
            self.assertEqual(config['host'],'127.0.0.1')
            self.assertFalse(config['autostart'])
            config['port']=8901
            app.save_config(config,p)
            self.assertEqual(app.load_config(p)['port'],8901)

    def test_corrupt_config_is_not_silently_overwritten(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'config.json';p.write_text('bad json')
            with self.assertRaises(ValueError): app.load_config(p)
            self.assertEqual(p.read_text(),'bad json')

    def test_startup_command_is_quoted_and_current_user_only(self):
        value=app.startup_command(Path('C:/Program Files/ICR Server/icr-server.exe'))
        self.assertEqual(value,'"C:/Program Files/ICR Server/icr-server.exe" --tray')

    def test_startup_registry_write_and_remove_use_hkcu(self):
        import sys
        from unittest.mock import MagicMock
        registry=MagicMock()
        with patch.dict(sys.modules,{'winreg':registry}), patch.object(app.sys,'platform','win32'), \
             patch.object(app.sys,'frozen',True,create=True):
            app.set_startup(True)
            registry.CreateKey.assert_called_with(registry.HKEY_CURRENT_USER,r'Software\Microsoft\Windows\CurrentVersion\Run')
            self.assertEqual(registry.SetValueEx.call_args.args[1],'ICRServer')
            app.set_startup(False)
            self.assertEqual(registry.DeleteValue.call_args.args[1],'ICRServer')

    def test_invalid_port_or_external_no_token_rejected(self):
        for values in [{'port':-1},{'host':'0.0.0.0','token':''}]:
            with tempfile.TemporaryDirectory() as d:
                with self.assertRaises(ValueError): app.save_config({**app.DEFAULT_CONFIG,**values},Path(d)/'x.json')

if __name__=='__main__':unittest.main()
