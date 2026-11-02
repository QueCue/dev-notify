"""系统凭据与向导回归：假密钥、临时文件、模拟 Keychain，不访问用户凭据。"""

import contextlib
import copy
import ctypes
import getpass
import io
import json
import os
import sys
import tempfile
import unittest
import warnings
from pathlib import Path
from unittest.mock import Mock, patch

from dev_notify import cli, credentials, setup
from dev_notify.config import EXAMPLE, ConfigError, load_config, parse_config

ID = "a" * 32
VALUES = {"telegram_token": "123:TEST_ONLY", "feishu_webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/TEST_ONLY", "feishu_secret": "TEST_ONLY"}


class MemoryStore:
    def __init__(self):
        self.items = {}
        self.deleted = []

    def read(self, identifier):
        return self.items[identifier]

    def write(self, identifier, data):
        if identifier in self.items:
            raise FileExistsError()
        self.items[identifier] = data

    def delete(self, identifier):
        self.deleted.append(identifier)
        self.items.pop(identifier, None)


class BaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="dev-notify-credential-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / "config.json"
        self.store = MemoryStore()
        patcher = patch.dict(os.environ, {"DEV_NOTIFY_HOME": str(self.root)}, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        native = patch.object(credentials, "system_store", side_effect=AssertionError("禁止访问真实系统凭据"))
        native.start()
        self.addCleanup(native.stop)
        network = patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("禁止联网"))
        network.start()
        self.addCleanup(network.stop)

    def data(self):
        data = copy.deepcopy(EXAMPLE)
        data["telegram"]["chat_ids"] = ["111"]
        data["credentials"] = {"backend": "system", "id": ID}
        return data

    def wizard(self, answers, secrets, expected=True):
        output = io.StringIO()
        factory = Mock(return_value=self.store)
        with patch("sys.stdin.isatty", return_value=True), contextlib.redirect_stdout(output):
            result = setup.wizard(self.path, ask=Mock(side_effect=answers),
                                  secret=Mock(side_effect=secrets), store_factory=factory)
        self.assertEqual(result, expected)
        self.assertNotIn("TEST_ONLY", output.getvalue())
        return output.getvalue()


class ReferenceTests(BaseTests):
    def test_reference_loads_once(self):
        loader = Mock(return_value=VALUES)
        config = parse_config(self.data(), self.path, env={}, bundle_loader=loader)
        self.assertTrue(config.telegram.configured)
        self.assertTrue(config.feishu.configured)
        self.assertEqual(config.telegram.token, VALUES["telegram_token"])
        self.assertNotIn("TEST_ONLY", repr(config))
        loader.assert_called_once_with(self.path, ID)

    def test_environment_empty_and_nonempty_override(self):
        loader = Mock(side_effect=AssertionError("不应访问系统存储"))
        env = {"TELEGRAM_BOT_TOKEN": "123:OVERRIDE", "FEISHU_WEBHOOK": "", "FEISHU_SECRET": ""}
        config = parse_config(self.data(), self.path, env=env, bundle_loader=loader)
        self.assertEqual(config.telegram.token, "123:OVERRIDE")
        self.assertFalse(config.feishu.configured)
        loader.assert_not_called()

    def test_disabled_channels_do_not_open_store(self):
        data = self.data()
        data["telegram"]["enabled"] = False
        data["feishu"]["enabled"] = False
        loader = Mock(side_effect=AssertionError("不应访问系统存储"))
        parse_config(data, self.path, env={}, bundle_loader=loader)
        loader.assert_not_called()

    def test_missing_reference_never_opens_store(self):
        parse_config(EXAMPLE, self.path, env={})
        credentials.system_store.assert_not_called()

    def test_invalid_reference_rejected(self):
        for reference in ({"backend": "plain", "id": ID}, {"backend": "system", "id": "../secret"},
                          {"backend": "system", "id": ID, "secret": "TEST_ONLY"}):
            data = self.data()
            data["credentials"] = reference
            with self.assertRaises(ValueError) as raised:
                parse_config(data, self.path, env={})
            self.assertNotIn("TEST_ONLY", str(raised.exception))

    def test_locked_store_is_error_not_silent_fallback(self):
        loader = Mock(side_effect=credentials.CredentialError("Keychain 已锁定"))
        with self.assertRaises(credentials.CredentialError):
            parse_config(self.data(), self.path, env={}, bundle_loader=loader)

    def test_bad_secret_bundle_redacted(self):
        for raw in (b"TEST_ONLY", b"[]", b'{"telegram_token":42}', b'{"unknown":"TEST_ONLY"}'):
            with self.assertRaises(credentials.CredentialError) as raised:
                credentials.decode_bundle(raw)
            self.assertNotIn("TEST_ONLY", str(raised.exception))


class WizardTests(BaseTests):
    def test_initial_setup_keeps_secrets_out_of_json(self):
        self.wizard(["3", "111,222", "y"], list(VALUES.values()))
        data = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(data["telegram"]["chat_ids"], ["111", "222"])
        self.assertNotIn("TEST_ONLY", self.path.read_text())
        self.assertEqual(credentials.decode_bundle(self.store.read(data["credentials"]["id"])), VALUES)
        self.assertFalse(self.path.with_name("config.json.setup.lock").exists())

    def test_cancel_does_not_write(self):
        self.wizard(["1", "111", "n"], [VALUES["telegram_token"]], expected=False)
        self.assertEqual(self.store.items, {})
        self.assertFalse(self.path.exists())
        self.assertEqual(list(self.root.iterdir()), [])

    def test_existing_decline_does_not_open_backend(self):
        original = json.dumps(EXAMPLE).encode()
        self.path.write_bytes(original)
        factory = Mock(side_effect=AssertionError("不应打开后端"))
        with patch("sys.stdin.isatty", return_value=True), contextlib.redirect_stdout(io.StringIO()):
            result = setup.wizard(self.path, ask=lambda _: "n", store_factory=factory)
        self.assertFalse(result)
        self.assertEqual(self.path.read_bytes(), original)
        factory.assert_not_called()

    def test_update_keeps_blank_values_then_deletes_old_bundle(self):
        self.path.write_text(json.dumps(self.data()), encoding="utf-8")
        self.store.items[ID] = json.dumps(VALUES).encode()
        self.wizard(["y", "3", "", "y"], ["", "", "-"])
        data = json.loads(self.path.read_text())
        self.assertNotEqual(data["credentials"]["id"], ID)
        self.assertNotIn(ID, self.store.items)
        saved = credentials.decode_bundle(self.store.read(data["credentials"]["id"]))
        self.assertEqual(saved["telegram_token"], VALUES["telegram_token"])
        self.assertEqual(saved["feishu_secret"], "")

    def test_missing_old_secret_can_be_reconfigured_explicitly(self):
        self.path.write_text(json.dumps(self.data()), encoding="utf-8")
        original_read = self.store.read
        def read(identifier):
            if identifier == ID:
                raise credentials.CredentialError("原凭据缺失")
            return original_read(identifier)
        self.store.read = read
        self.wizard(["y", "1", "y", "111", "y"], [VALUES["telegram_token"]])
        data = json.loads(self.path.read_text())
        self.assertNotEqual(data["credentials"]["id"], ID)
        self.assertFalse(data["feishu"]["enabled"])

    def test_invalid_input_does_not_write(self):
        with patch("sys.stdin.isatty", return_value=True), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(ConfigError):
                setup.wizard(self.path, ask=Mock(side_effect=["1", "abc"]),
                             secret=lambda _: VALUES["telegram_token"], store_factory=lambda *a, **k: self.store)
        self.assertFalse(self.path.exists())
        self.assertEqual(self.store.items, {})

    def test_noninteractive_rejected_before_writes(self):
        with patch("sys.stdin.isatty", return_value=False):
            with self.assertRaises(ConfigError):
                setup.wizard(self.path)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_hidden_input_must_not_fall_back_to_echo(self):
        def unsafe(_):
            warnings.warn("会回显", getpass.GetPassWarning)
            raise AssertionError("不应进入回显阶段")
        with patch.object(getpass, "getpass", side_effect=unsafe):
            with self.assertRaises(ConfigError):
                setup.read_secret("密码:")

    def test_template_cli_never_opens_store(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(["--config", str(self.path), "setup", "--template", "--yes"]), 0)
        credentials.system_store.assert_not_called()


class TransactionTests(BaseTests):
    def test_failed_config_replace_preserves_original_and_removes_new_secret(self):
        data = self.data()
        before = json.dumps(data).encode()
        self.path.write_bytes(before)
        self.store.items[ID] = json.dumps(VALUES).encode()
        with patch.object(setup.os, "replace", side_effect=PermissionError()):
            with self.assertRaises(PermissionError):
                setup.persist(self.path, data, VALUES, before, self.store)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(set(self.store.items), {ID})
        self.assertEqual(set(p.name for p in self.root.iterdir()), {"config.json"})

    def test_concurrent_change_is_not_overwritten(self):
        self.path.write_bytes(b"changed")
        with self.assertRaises(ConfigError):
            setup.persist(self.path, EXAMPLE, VALUES, None, self.store)
        self.assertEqual(self.path.read_bytes(), b"changed")
        self.assertEqual(self.store.items, {})

    def test_change_during_secret_write_rolls_back_only_new_secret(self):
        original_write = self.store.write
        def write(identifier, data):
            original_write(identifier, data)
            self.path.write_bytes(b"external edit")
        self.store.write = write
        with self.assertRaises(ConfigError):
            setup.persist(self.path, EXAMPLE, VALUES, None, self.store)
        self.assertEqual(self.path.read_bytes(), b"external edit")
        self.assertEqual(self.store.items, {})

    def test_locked_transaction_does_not_touch_other_lock(self):
        lock = self.path.with_name("config.json.setup.lock")
        lock.write_text("other")
        with self.assertRaises(ConfigError):
            setup.persist(self.path, EXAMPLE, VALUES, None, self.store)
        self.assertEqual(lock.read_text(), "other")
        self.assertEqual(self.store.items, {})

    def test_failed_verification_removes_new_bundle(self):
        self.store.read = Mock(return_value=b"{}")
        with self.assertRaises(credentials.CredentialError):
            setup.persist(self.path, EXAMPLE, VALUES, None, self.store)
        self.assertFalse(self.path.exists())
        self.assertEqual(self.store.items, {})

    def test_failed_cleanup_reports_safe_identifier(self):
        self.store.delete = Mock(side_effect=OSError("TEST_ONLY"))
        output = io.StringIO()
        with patch.object(setup.os, "replace", side_effect=PermissionError()), contextlib.redirect_stderr(output):
            with self.assertRaises(PermissionError):
                setup.persist(self.path, EXAMPLE, VALUES, None, self.store)
        self.assertIn("残留引用 ID", output.getvalue())
        self.assertNotIn("TEST_ONLY", output.getvalue())
        self.assertFalse(self.path.exists())


class BackendTests(BaseTests):
    def test_windows_store_writes_ciphertext_only(self):
        store = credentials.WindowsStore(self.path)
        raw = json.dumps(VALUES).encode()
        with patch.object(credentials, "dpapi", side_effect=lambda data, **kw: raw if kw.get("decrypt") else b"ciphertext"):
            store.write(ID, raw)
            self.assertEqual((self.root / "credentials" / (ID + ".dpapi")).read_bytes(), b"ciphertext")
            self.assertEqual(store.read(ID), raw)
            with self.assertRaises(FileExistsError):
                store.write(ID, raw)
            store.delete(ID)
            self.assertFalse((self.root / "credentials" / (ID + ".dpapi")).exists())

    def test_windows_store_rejects_traversal(self):
        store = credentials.WindowsStore(self.path)
        with self.assertRaises(credentials.CredentialError):
            store.read("../secret")

    @unittest.skipUnless(sys.platform == "win32", "只在 Windows 验证假密钥的内存 DPAPI 往返")
    def test_real_dpapi_in_memory_with_dummy_secret(self):
        original = b"dev-notify-test-only-not-a-real-secret"
        encrypted = credentials.dpapi(original)
        self.assertNotIn(original, encrypted)
        self.assertEqual(credentials.dpapi(encrypted, decrypt=True), original)

    def test_keychain_read_frees_native_memory(self):
        store = credentials.MacStore()
        security, core = Mock(), Mock()
        buffer = ctypes.create_string_buffer(b"dummy")
        def find(keychain, service_len, service, account_len, account, length, password, item):
            ctypes.cast(length, ctypes.POINTER(ctypes.c_uint32))[0] = 5
            ctypes.cast(password, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.cast(buffer, ctypes.c_void_p)
            return 0
        security.SecKeychainFindGenericPassword.side_effect = find
        with patch.object(store, "_api", return_value=(security, core)):
            self.assertEqual(store.read(ID), b"dummy")
        security.SecKeychainItemFreeContent.assert_called_once()

    def test_keychain_locked_error_redacted(self):
        store = credentials.MacStore()
        security = Mock()
        security.SecKeychainFindGenericPassword.return_value = -25308
        with patch.object(store, "_api", return_value=(security, Mock())):
            with self.assertRaises(credentials.CredentialError):
                store.read(ID)
        security.SecKeychainItemFreeContent.assert_not_called()

    def test_keychain_write_uses_memory_not_subprocess(self):
        store = credentials.MacStore(interactive=True)
        security = Mock()
        security.SecKeychainAddGenericPassword.return_value = 0
        with patch.object(store, "_api", return_value=(security, Mock())):
            store.write(ID, b"dummy")
        args = security.SecKeychainAddGenericPassword.call_args.args
        self.assertEqual(args[2], credentials.SERVICE)
        self.assertEqual(args[4], ID.encode())
        self.assertEqual(ctypes.string_at(args[6], args[5]), b"dummy")

    def test_keychain_delete_releases_item(self):
        store = credentials.MacStore()
        security, core = Mock(), Mock()
        def find(*args):
            ctypes.cast(args[-1], ctypes.POINTER(ctypes.c_void_p))[0] = 123
            return 0
        security.SecKeychainFindGenericPassword.side_effect = find
        security.SecKeychainItemDelete.return_value = 0
        with patch.object(store, "_api", return_value=(security, core)):
            store.delete(ID)
        security.SecKeychainItemDelete.assert_called_once()
        core.CFRelease.assert_called_once()


if __name__ == "__main__":
    unittest.main(verbosity=2)
