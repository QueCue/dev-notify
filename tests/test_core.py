"""基础 CLI 与渠道的无副作用回归测试。"""

import contextlib
import copy
import io
import json
import os
import tempfile
import unittest
import urllib.error
from html.parser import HTMLParser
from pathlib import Path
from unittest.mock import Mock, patch

from dev_notify import cli
from dev_notify.channels import feishu, telegram
from dev_notify.config import ConfigError, FeishuConfig, TelegramConfig, create_config, load_config
from dev_notify.formatting import message_parts, telegram_markdown
from dev_notify.models import DeliveryResult, Message
from dev_notify.paths import app_paths
from dev_notify.transport import NoRedirect, TransportError, request_json


class BaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="dev-notify-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.env = {"DEV_NOTIFY_HOME": str(self.root)}
        environment = patch.dict(os.environ, self.env, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        network = patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("禁止真实网络请求"))
        network.start()
        self.addCleanup(network.stop)

    def invoke(self, *args):
        output, error = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            code = cli.main(list(args))
        return code, output.getvalue() + error.getvalue()


class ConfigTests(BaseTests):
    def test_platform_paths(self):
        home = self.root
        win = app_paths("win32", {}, home)
        mac = app_paths("darwin", {}, home)
        self.assertEqual(win.config, home / "AppData/Roaming/DevNotify/config.json")
        self.assertEqual(win.data, home / "AppData/Local/DevNotify/data")
        self.assertEqual(mac.config, home / "Library/Application Support/DevNotify/config/config.json")
        self.assertFalse(win.config.parent.exists())
        self.assertFalse(mac.config.parent.exists())

    def test_override_does_not_create_directories(self):
        result = app_paths(env=self.env)
        self.assertEqual(result.config, self.root / "config/config.json")
        self.assertEqual(list(self.root.iterdir()), [])
        with self.assertRaises(ValueError):
            app_paths(env={"DEV_NOTIFY_HOME": "relative"})

    def test_strict_configuration(self):
        path = self.root / "input.json"
        cases = [[], {"version": 2}, {"telegram": []}, {"telegram": {"enabled": "false"}},
                 {"telegram": {"token": "DO_NOT_PRINT"}}, {"telegram": {"chat_ids": [True]}},
                 {"telegram": {"chat_ids": ["abc"]}}, {"feishu": {"secret_env": "bad name"}}]
        for data in cases:
            path.write_text(json.dumps(data), encoding="utf-8")
            with self.subTest(data=data), self.assertRaises(ConfigError) as raised:
                load_config(path, env={})
            self.assertNotIn("DO_NOT_PRINT", str(raised.exception))

    def test_corrupt_config_does_not_fall_back(self):
        path = self.root / "input.json"
        path.write_text('{"token":DO_NOT_PRINT}', encoding="utf-8")
        with self.assertRaises(ConfigError) as raised:
            load_config(path)
        self.assertNotIn("DO_NOT_PRINT", str(raised.exception))

    def test_environment_replaces_receivers_including_empty(self):
        path = self.root / "input.json"
        path.write_text(json.dumps({"telegram": {"chat_ids": [111, "222"]}}), encoding="utf-8")
        cases = [({}, ("111", "222")), ({"TELEGRAM_CHAT_ID": "333"}, ("333",)),
                 ({"TELEGRAM_CHAT_IDS": "333,444,333"}, ("333", "444")),
                 ({"TELEGRAM_CHAT_ID": "333", "TELEGRAM_CHAT_IDS": "444"}, ("333", "444")),
                 ({"TELEGRAM_CHAT_IDS": ""}, ())]
        for env, expected in cases:
            self.assertEqual(load_config(path, env=env).telegram.chat_ids, expected)

    def test_credentials_are_not_in_repr(self):
        config = load_config(self.root / "absent", env={
            "TELEGRAM_BOT_TOKEN": "123:SECRET", "TELEGRAM_CHAT_ID": "111",
            "FEISHU_WEBHOOK": "https://open.feishu.cn/open-apis/bot/v2/hook/SECRET",
            "FEISHU_SECRET": "SECRET"})
        self.assertNotIn("SECRET", repr(config))
        self.assertTrue(config.telegram.configured)
        self.assertTrue(config.feishu.configured)

    def test_webhook_rejects_other_hosts(self):
        for address in ("http://open.feishu.cn/open-apis/bot/v2/hook/secret", "https://example.com/secret",
                        "https://open.feishu.cn.evil.test/open-apis/bot/v2/hook/secret"):
            with self.assertRaises(ConfigError):
                load_config(self.root / "absent", env={"FEISHU_WEBHOOK": address})

    def test_template_cannot_overwrite(self):
        path = self.root / "nested/config.json"
        create_config(path)
        before = path.read_bytes()
        with self.assertRaises(FileExistsError):
            create_config(path)
        self.assertEqual(path.read_bytes(), before)
        self.assertNotIn("token", json.loads(before)["telegram"])


class CliTests(BaseTests):
    def test_paths_doctor_status_have_no_side_effects(self):
        self.assertEqual(self.invoke("paths")[0], 0)
        self.assertEqual(self.invoke("doctor")[0], 1)
        self.assertEqual(self.invoke("status")[0], 1)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_setup_requires_consent_and_preserves_existing(self):
        with patch("sys.stdin", io.StringIO()):
            self.assertEqual(self.invoke("setup")[0], 2)
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual(self.invoke("setup", "--yes")[0], 0)
        self.assertEqual(self.invoke("setup", "--yes")[0], 2)

    def test_explicit_missing_config_is_error(self):
        code, text = self.invoke("--config", str(self.root / "missing"), "doctor")
        self.assertEqual(code, 2)
        self.assertIn("不存在", text)

    def test_no_channel_is_error(self):
        self.assertEqual(self.invoke("send", "--title", "标题")[0], 2)

    def test_dry_run_redacts_payload_and_credentials(self):
        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "123:SECRET", "TELEGRAM_CHAT_ID": "111"}):
            code, text = self.invoke("send", "--title", "PRIVATE_TITLE", "--content", "PRIVATE_BODY" * 1000, "--dry-run")
        self.assertEqual(code, 0)
        for value in ("SECRET", "PRIVATE_BODY", "PRIVATE_TITLE"):
            self.assertNotIn(value, text)
        self.assertIn("未发送", text)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_file_error_does_not_send_title(self):
        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "123:SECRET", "TELEGRAM_CHAT_ID": "111"}), patch.object(telegram, "send") as send:
            self.assertEqual(self.invoke("send", "--title", "标题", "--content-file", str(self.root / "missing"))[0], 2)
            send.assert_not_called()

    def test_invalid_utf8_does_not_send(self):
        path = self.root / "bad.txt"
        path.write_bytes(b"\xff\xfe")
        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "123:SECRET", "TELEGRAM_CHAT_ID": "111"}), patch.object(telegram, "send") as send:
            self.assertEqual(self.invoke("send", "--title", "标题", "--content-file", str(path))[0], 2)
            send.assert_not_called()

    def test_partial_channel_failure_has_nonzero_exit(self):
        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "123:SECRET", "TELEGRAM_CHAT_ID": "111",
                                   "FEISHU_WEBHOOK": "https://open.feishu.cn/open-apis/bot/v2/hook/secret"}), \
                patch.object(telegram, "send", return_value=DeliveryResult("telegram", 1, 1)), \
                patch.object(feishu, "send", return_value=DeliveryResult("feishu", 1, 0, "失败")):
            self.assertEqual(self.invoke("send", "--title", "标题")[0], 1)

    def test_stdin_and_content_file_are_complete(self):
        text = "完整正文😀" * 2000
        path = self.root / "body.txt"
        path.write_text(text, encoding="utf-8-sig")
        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "123:SECRET", "TELEGRAM_CHAT_ID": "111"}), patch.object(telegram, "send", return_value=DeliveryResult("telegram", 1, 1)) as send:
            for args in (("--content-file", str(path)), ("--stdin",)):
                with patch("sys.stdin", io.StringIO(text)):
                    self.assertEqual(self.invoke("send", "--title", "标题", *args)[0], 0)
                plan = send.call_args.args[0]
                bodies = [message_parts.PlainHtml(p["text"]).split("\n\n", 1)[1] for p in plan.payloads]
                self.assertEqual("".join(bodies), text)

    def test_integration_does_not_claim_installed(self):
        code, text = self.invoke("integration", "list")
        self.assertEqual(code, 0)
        self.assertIn("尚未接入", text)
        self.assertEqual(list(self.root.iterdir()), [])


class ChannelTests(BaseTests):
    def test_telegram_long_content_preserved(self):
        config = TelegramConfig("123:SECRET", ("111", "222"))
        examples = ["😀中文<&>" * 2000, "```python\n" + 'print("中文")\n' * 1000 + "```",
                    "| " + "A" * 1000 + " | B |\n| --- | --- |\n" + "| x | y |\n" * 8]
        for content in examples:
            plan = telegram.plan(Message("标题", content, footer="辅助信息"), config)
            self.assertGreater(len(plan.payloads), 2)
            for chat_id in config.chat_ids:
                texts = [message_parts.PlainHtml(p["text"]) for p in plan.payloads if p["chat_id"] == chat_id]
                for text in texts:
                    self.assertLessEqual(message_parts.TextLength(text), 4096)
                actual = "".join(t.split("\n\n", 1)[1].rsplit("\n\n────────\n", 1)[0] for t in texts)
                self.assertEqual(actual, telegram_markdown.ToPlainText(content))

    def test_html_split_balances_tags(self):
        class Balance(HTMLParser):
            def __init__(self):
                super().__init__()
                self.stack = []
            def handle_starttag(self, tag, attrs):
                self.stack.append(tag)
            def handle_endtag(self, tag):
                if not self.stack or self.stack.pop() != tag:
                    raise AssertionError("标签不平衡")
        html = '<b>' + '甲😀 &amp; &lt;x&gt; ' * 100 + '<i>末尾</i></b>'
        chunks = message_parts.SplitHtml(html, 97)
        for chunk in chunks:
            parser = Balance()
            parser.feed(chunk)
            self.assertEqual(parser.stack, [])
        self.assertEqual("".join(message_parts.PlainHtml(c) for c in chunks), message_parts.PlainHtml(html))

    def test_telegram_format_fallback_keeps_all_parts(self):
        config = TelegramConfig("123:SECRET", ("111",))
        plan = telegram.plan(Message("标题", "正文😀" * 3000), config)
        calls = []
        def request(url, payload, **kwargs):
            calls.append(dict(payload))
            return {"ok": False, "description": "can't parse entities"} if "parse_mode" in payload else {"ok": True}
        result = telegram.send(plan, config, request=request)
        self.assertTrue(result.ok)
        self.assertEqual(len(calls), len(plan.payloads) * 2)
        self.assertTrue(all("parse_mode" not in calls[i] for i in range(1, len(calls), 2)))

    def test_telegram_rate_retry_bounded(self):
        config = TelegramConfig("123:SECRET", ("111",))
        plan = telegram.plan(Message("标题", "正文"), config)
        request = Mock(side_effect=[{"ok": False, "error_code": 429, "parameters": {"retry_after": 2}}, {"ok": True}])
        sleep = Mock()
        self.assertTrue(telegram.send(plan, config, request=request, sleep=sleep).ok)
        self.assertEqual(request.call_count, 2)
        sleep.assert_called_once_with(2)

    def test_telegram_partial_failure_continues_other_recipient(self):
        config = TelegramConfig("123:SECRET", ("111", "222"))
        plan = telegram.plan(Message("标题", "正文" * 5000), config)
        calls = []
        def request(url, payload, **kwargs):
            calls.append(payload)
            return {"ok": payload["chat_id"] == "222", "description": "SECRET"}
        result = telegram.send(plan, config, request=request)
        self.assertFalse(result.ok)
        self.assertEqual(sum(c["chat_id"] == "111" for c in calls), 1)
        self.assertEqual(result.sent, len(plan.payloads) // 2)
        self.assertNotIn("SECRET", result.error)

    def test_feishu_fallback_and_split_preserve_content(self):
        config = FeishuConfig("https://open.feishu.cn/open-apis/bot/v2/hook/SECRET", "SECRET")
        content = "正文😀\n\n" * 3000
        plan = feishu.plan(Message("标题", content, footer="辅助"), config)
        calls = []
        def request(url, body):
            calls.append(copy.deepcopy(body))
            return {"code": 1 if body["card"]["elements"][0]["tag"] == "markdown" else 0}
        sleep = Mock()
        self.assertTrue(feishu.send(plan, config, request=request, sleep=sleep).ok)
        self.assertGreater(len(plan.payloads), 1)
        self.assertEqual(len(calls), len(plan.payloads) * 2)
        bodies = [body["card"]["elements"][0]["text"]["content"] for body in calls[1::2]]
        self.assertEqual("".join(bodies), content)
        for body in calls:
            self.assertLess(feishu.encoded_size(body), feishu.MAX_CARD_BYTES)
            self.assertIn("sign", body)
        self.assertNotIn("sign", plan.payloads[0])
        self.assertEqual(sleep.call_count, len(plan.payloads) - 1)

    def test_oversize_metadata_rejected_before_network(self):
        with self.assertRaises(ValueError):
            telegram.plan(Message("甲" * 5000, "正文"), TelegramConfig("123:secret", ("111",)))
        with self.assertRaises(ValueError):
            feishu.plan(Message("甲" * 10000, "正文"), FeishuConfig("https://fake.invalid"))

    def test_feishu_code_fences_balanced(self):
        import re
        config = FeishuConfig("https://fake.invalid")
        plan = feishu.plan(Message("标题", "```python\n" + "print(1)\n" * 3000 + "```"), config)
        for body in plan.payloads:
            content = body["card"]["elements"][0]["content"]
            self.assertEqual(len(re.findall(r"^`{3,}.*$", content, re.MULTILINE)) % 2, 0)


class TransportTests(BaseTests):
    def test_network_error_redacted(self):
        with patch("urllib.request.build_opener") as factory:
            factory.return_value.open.side_effect = OSError("https://example.invalid/SECRET")
            with self.assertRaises(TransportError) as error:
                request_json("https://example.invalid/SECRET", {})
        self.assertNotIn("SECRET", str(error.exception))

    def test_redirect_is_not_followed(self):
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.invalid"))
        with patch("urllib.request.build_opener") as factory:
            factory.return_value.open.side_effect = urllib.error.HTTPError(
                "https://example.invalid/SECRET", 302, "SECRET", {}, io.BytesIO())
            with self.assertRaises(TransportError) as error:
                request_json("https://example.invalid/SECRET", {})
        self.assertNotIn("SECRET", str(error.exception))

    def test_invalid_response_shape(self):
        response = io.BytesIO(b"[]")
        with patch("urllib.request.build_opener") as factory:
            factory.return_value.open.return_value = response
            with self.assertRaises(TransportError):
                request_json("https://example.invalid", {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
