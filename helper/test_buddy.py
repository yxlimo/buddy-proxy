#!/usr/bin/env python3
"""buddy-helper 的离线自检。

不联网、不跑真客户端：额度解析、恢复时间、会话查找、发消息的命令、归档、
同步的一致性比对 —— 全在这里跑一遍。

    python3 -m unittest discover -s helper -p 'test_*.py'
"""
import argparse
import datetime
import json
import os
import pathlib
import sys
import tempfile
import typing
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import buddy_sync  # noqa: E402
import buddy_todo  # noqa: E402
import common  # noqa: E402


def health_payload(accounts) -> dict:
    """造一个 /health 的样子。"""
    return {"upstreams": {"minimax": {"accounts": accounts}}}


def account(
    account_id="minimax",
    percent=0,
    ends_at=None,
    cooldown_until=None,
    out_of_credits=False,
    windows=None,
    token_plan=True,
) -> dict:
    """造一个账号。windows 缺省给一个 general 窗口。"""
    entry = {"id": account_id, "outOfCredits": out_of_credits}
    if token_plan:
        if windows is None:
            windows = [
                {"model": "general", "intervalPercent": percent, "intervalEndsAt": ends_at}
            ]
        entry["snapshot"] = {"tokenPlan": {"windows": windows}}
    if cooldown_until is not None:
        entry["cooldown"] = {"untilMs": cooldown_until}
    return entry


class ParseHealthTest(unittest.TestCase):
    def test_two_accounts_with_general_window(self):
        payload = health_payload(
            [
                account("minimax", percent=0, ends_at="2026-10-29T07:00:00.000Z"),
                account("minimax-2", percent=89, ends_at="2026-10-29T11:34:24.360Z"),
            ]
        )
        accounts = buddy_todo.parse_health(payload)
        self.assertEqual(len(accounts), 2)
        self.assertEqual(accounts[0]["id"], "minimax")
        self.assertEqual(accounts[0]["interval_percent"], 0)
        self.assertEqual(accounts[1]["interval_percent"], 89)
        self.assertEqual(
            accounts[1]["interval_ends_at"],
            common.to_ms("2026-10-29T11:34:24.360Z"),
        )

    def test_video_window_is_not_counted(self):
        payload = health_payload(
            [
                account(
                    "minimax",
                    windows=[
                        {"model": "video", "intervalPercent": 100, "intervalEndsAt": "2026-10-29T07:00:00.000Z"},
                    ],
                )
            ]
        )
        accounts = buddy_todo.parse_health(payload)
        self.assertEqual(accounts[0]["interval_percent"], 0)
        self.assertEqual(accounts[0]["interval_ends_at"], 0)

    def test_account_without_token_plan_gets_safe_default(self):
        payload = health_payload([account("minimax", token_plan=False)])
        accounts = buddy_todo.parse_health(payload)
        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0]["interval_percent"], 0)
        self.assertEqual(accounts[0]["interval_ends_at"], 0)
        self.assertFalse(accounts[0]["out_of_credits"])

    def test_cooldown_and_out_of_credits_are_read(self):
        payload = health_payload(
            [account("minimax", cooldown_until=1_800_000_000_000, out_of_credits=True)]
        )
        accounts = buddy_todo.parse_health(payload)
        self.assertEqual(accounts[0]["cooldown_until_ms"], 1_800_000_000_000)
        self.assertTrue(accounts[0]["out_of_credits"])

    def test_garbage_payload_gives_no_accounts(self):
        self.assertEqual(buddy_todo.parse_health(None), [])
        self.assertEqual(buddy_todo.parse_health({"upstreams": {}}), [])


class NextRecoveryTest(unittest.TestCase):
    NOW = 1_700_000_000_000

    def plan_for(self, payload, grace_ms=60_000) -> dict:
        """算恢复时间；算不出来就让测试失败。"""
        accounts = buddy_todo.parse_health(payload)
        plan = buddy_todo.next_recovery(accounts, self.NOW, grace_ms)
        if plan is None:
            self.fail("算不出恢复时间")
        return typing.cast(dict, plan)

    def test_account_with_quota_is_usable_now(self):
        plan = self.plan_for(
            health_payload([account("minimax-2", percent=89, ends_at="2026-10-29T11:34:24.360Z")])
        )
        self.assertTrue(plan["usable"])
        self.assertEqual(plan["at"], self.NOW)

    def test_all_unavailable_takes_the_earliest(self):
        plan = self.plan_for(
            health_payload(
                [
                    account("minimax", percent=0, ends_at="2026-10-29T07:00:00.000Z"),
                    account("minimax-2", percent=0, ends_at="2026-10-29T11:34:24.360Z"),
                ]
            )
        )
        self.assertFalse(plan["usable"])
        # 最早的窗口 + grace
        self.assertEqual(plan["recovers_at"], common.to_ms("2026-10-29T07:00:00.000Z"))
        self.assertEqual(plan["at"], plan["recovers_at"] + 60_000)

    def test_cooldown_later_than_window_wins(self):
        cooldown = self.NOW + 900_000
        plan = self.plan_for(
            health_payload(
                [
                    account(
                        "minimax",
                        percent=0,
                        ends_at=self.NOW + 60_000,
                        cooldown_until=cooldown,
                    )
                ]
            ),
            grace_ms=0,
        )
        self.assertFalse(plan["usable"])
        self.assertEqual(plan["recovers_at"], cooldown)

    def test_out_of_credits_is_not_usable(self):
        plan = self.plan_for(
            health_payload([account("minimax", percent=100, ends_at=self.NOW + 3_600_000, out_of_credits=True)]),
            grace_ms=0,
        )
        self.assertFalse(plan["usable"])

    def test_no_time_at_all_returns_none(self):
        accounts = buddy_todo.parse_health(
            health_payload([account("minimax", percent=0, token_plan=False)])
        )
        self.assertIsNone(buddy_todo.next_recovery(accounts, self.NOW, 60_000))


class ResolveAtTest(unittest.TestCase):
    """`at` 只有一个来源选择问题：自动算与手动给。

    自动算出来的时刻和 `--at` 给的时刻走的是同一段等待代码。
    """

    NOW = datetime.datetime(2026, 10, 29, 9, 0, 0)

    def args(self, now=False, at=None, grace=60) -> argparse.Namespace:
        return argparse.Namespace(now=now, at=at, grace=grace)

    def test_without_at_usable_quota_means_now(self):
        payload = health_payload(
            [account("minimax", percent=89, ends_at="2026-10-29T11:34:24.360Z")]
        )
        calls = []

        def reader():
            calls.append(1)
            return buddy_todo.parse_health(payload), ""

        resolved = buddy_todo.resolve_at(self.args(), reader=reader, now=self.NOW)
        self.assertEqual(resolved["error"], "")
        self.assertEqual(len(calls), 1)
        self.assertTrue(resolved["plan"]["usable"])
        self.assertAlmostEqual(resolved["at"], self.NOW.timestamp(), delta=1)

    def test_without_at_unusable_quota_means_recovery_plus_grace(self):
        recovers = "2026-10-29T11:00:00.000Z"
        payload = health_payload(
            [account("minimax", percent=0, ends_at=recovers)]
        )

        def reader():
            return buddy_todo.parse_health(payload), ""

        resolved = buddy_todo.resolve_at(self.args(grace=60), reader=reader, now=self.NOW)
        self.assertEqual(resolved["error"], "")
        self.assertFalse(resolved["plan"]["usable"])
        self.assertAlmostEqual(
            resolved["at"],
            common.to_ms(recovers) / 1000 + 60,
            delta=1,
        )

    def test_manual_at_is_used_as_is_and_no_quota_is_read(self):
        def reader():
            raise AssertionError("给了 --at 就不该查额度")

        resolved = buddy_todo.resolve_at(self.args(at="14:30"), reader=reader, now=self.NOW)
        self.assertEqual(resolved["error"], "")
        self.assertIsNone(resolved["plan"])
        self.assertEqual(
            resolved["at"],
            self.NOW.replace(hour=14, minute=30, second=0, microsecond=0).timestamp(),
        )

    def test_now_means_now(self):
        def reader():
            raise AssertionError("--now 就不该查额度")

        resolved = buddy_todo.resolve_at(self.args(now=True), reader=reader, now=self.NOW)
        self.assertEqual(resolved["error"], "")
        self.assertIsNone(resolved["plan"])
        self.assertAlmostEqual(resolved["at"], self.NOW.timestamp(), delta=1)

    def test_unreadable_quota_is_an_error(self):
        def reader():
            return [], "连不上"

        resolved = buddy_todo.resolve_at(self.args(), reader=reader, now=self.NOW)
        self.assertNotEqual(resolved["error"], "")
        self.assertEqual(resolved["code"], buddy_todo.EXIT_NO_GATEWAY)


class GatewayConfigTest(unittest.TestCase):
    """网关地址的优先级：--gateway > BUDDY_GATEWAY > 配置文件 > 报错。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.config = pathlib.Path(self.tmp.name) / "config.json"
        self.saved_env = os.environ.pop(common.ENV_GATEWAY, None)

    def tearDown(self):
        if self.saved_env is not None:
            os.environ[common.ENV_GATEWAY] = self.saved_env
        else:
            os.environ.pop(common.ENV_GATEWAY, None)
        self.tmp.cleanup()

    def write_config(self, gateway: str) -> None:
        self.config.write_text(json.dumps({"gateway": gateway}), encoding="utf-8")

    def test_command_line_wins(self):
        self.write_config("http://config:6450")
        os.environ[common.ENV_GATEWAY] = "http://env:6450"
        gateway, err = common.resolve_gateway("http://cli:6450", self.config)
        self.assertEqual(err, "")
        self.assertEqual(gateway, "http://cli:6450")

    def test_env_wins_over_config(self):
        self.write_config("http://config:6450")
        os.environ[common.ENV_GATEWAY] = "http://env:6450"
        gateway, err = common.resolve_gateway(None, self.config)
        self.assertEqual(err, "")
        self.assertEqual(gateway, "http://env:6450")

    def test_config_is_the_last_source(self):
        self.write_config("http://config:6450")
        gateway, err = common.resolve_gateway(None, self.config)
        self.assertEqual(err, "")
        self.assertEqual(gateway, "http://config:6450")

    def test_nothing_configured_is_an_error_with_exit_code_five(self):
        gateway, err = common.resolve_gateway(None, self.config)
        self.assertEqual(gateway, "")
        self.assertIn("没有配置网关地址", err)
        self.assertEqual(common.EXIT_NO_GATEWAY, 5)

    def test_set_gateway_writes_the_file_and_it_reads_back(self):
        path = common.set_gateway("http://192.168.50.4:6450", self.config)
        self.assertEqual(path, self.config)
        self.assertTrue(self.config.is_file())
        self.assertEqual(common.read_gateway_config(self.config), "http://192.168.50.4:6450")
        gateway, err = common.resolve_gateway(None, self.config)
        self.assertEqual(err, "")
        self.assertEqual(gateway, "http://192.168.50.4:6450")

    def test_set_gateway_keeps_the_other_keys(self):
        self.config.write_text(json.dumps({"other": 1}), encoding="utf-8")
        common.set_gateway("http://192.168.50.4:6450", self.config)
        data = json.loads(self.config.read_text(encoding="utf-8"))
        self.assertEqual(data["other"], 1)
        self.assertEqual(data["gateway"], "http://192.168.50.4:6450")


class PiSessionsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        # pi 用工作目录的绝对路径当会话目录名，这里编一个。
        self.cwd = "/srv/work/x"
        self.dir = self.root / "--srv-work-x--"
        self.dir.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def _session(self, name: str) -> pathlib.Path:
        path = self.dir / f"{name}.jsonl"
        path.write_text(
            json.dumps({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "给网关接个七牛"}]}})
            + "\n",
            encoding="utf-8",
        )
        return path

    def test_only_real_sessions_are_listed(self):
        real = self._session("2026-10-26T11-59-43-440Z_01a17814-ad50-775e-8c08-6ff8df765b64")
        # 子代理产物目录：没有 transcript，不是会话。
        artifacts = self.dir / "subagent-artifacts"
        artifacts.mkdir()
        (artifacts / "note.md").write_text("x", encoding="utf-8")
        os.utime(artifacts, (9_000_000_000, 9_000_000_000))

        found = common.pi_sessions(self.root, self.cwd)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["id"], "01a17814-ad50-775e-8c08-6ff8df765b64")
        self.assertEqual(found[0]["path"], str(real.resolve()))
        self.assertEqual(found[0]["title"], "给网关接个七牛")

    def test_directory_without_transcript_is_skipped(self):
        (self.dir / "2026-10-26T11-59-43-440Z_01a17814-ad50-775e-8c08-6ff8df765b64").mkdir()
        found = common.pi_sessions(self.root, self.cwd)
        self.assertEqual(found, [])

    def test_directory_with_sibling_transcript_counts(self):
        name = "2026-10-26T11-59-43-440Z_01a17814-ad50-775e-8c08-6ff8df765b64"
        (self.dir / name).mkdir()
        (self.dir / f"{name}.jsonl").write_text("", encoding="utf-8")
        found = common.pi_sessions(self.root, self.cwd)
        self.assertEqual(len(found), 1)
        self.assertTrue(found[0]["path"].endswith(f"{name}.jsonl"))

    def test_newest_first(self):
        old = self._session("2026-10-20T01-00-00-000Z_aaaaaaaa-1111-2222-3333-444444444444")
        new = self._session("2026-10-26T11-59-43-440Z_01a17814-ad50-775e-8c08-6ff8df765b64")
        os.utime(old, (1_000_000, 1_000_000))
        os.utime(new, (2_000_000, 2_000_000))
        found = common.pi_sessions(self.root, self.cwd)
        self.assertEqual(found[0]["id"], "01a17814-ad50-775e-8c08-6ff8df765b64")


class SessionIdOfTest(unittest.TestCase):
    def test_uuid_name(self):
        self.assertEqual(
            common.session_id_of("01a17814-ad50-775e-8c08-6ff8df765b64"),
            "01a17814-ad50-775e-8c08-6ff8df765b64",
        )

    def test_timestamp_with_any_name(self):
        self.assertEqual(
            common.session_id_of("2026-10-29T03-58-17-343Z_nudge-test-1"),
            "nudge-test-1",
        )

    def test_subagent_artifacts_has_no_id(self):
        self.assertIsNone(common.session_id_of("subagent-artifacts"))

    def test_empty_name_has_no_id(self):
        self.assertIsNone(common.session_id_of(""))
        self.assertIsNone(common.session_id_of(None))


class OpencodeSessionsTest(unittest.TestCase):
    def test_parses_fixture(self):
        payload = json.dumps(
            [
                {
                    "id": "ses_e8f1b3e2cffeh5",
                    "title": "Pi 隐藏调用 js_reserve skill",
                    "updated": 1_700_000_000_000,
                }
            ]
        )
        found, err = common.opencode_sessions("/srv/work/x", runner=lambda cwd: payload)
        self.assertEqual(err, "")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["id"], "ses_e8f1b3e2cffeh5")
        self.assertEqual(found[0]["title"], "Pi 隐藏调用 js_reserve skill")
        self.assertEqual(found[0]["updated_ms"], 1_700_000_000_000)

    def test_sessions_key_shape(self):
        payload = json.dumps({"sessions": [{"id": "ses_x", "time": {"updated": 1_700_000_000_000}}]})
        found, err = common.opencode_sessions("/srv/work/x", runner=lambda cwd: payload)
        self.assertEqual(err, "")
        self.assertEqual(found[0]["id"], "ses_x")
        self.assertEqual(found[0]["updated_ms"], 1_700_000_000_000)

    def test_broken_output_reports_error(self):
        found, err = common.opencode_sessions("/srv/work/x", runner=lambda cwd: "not json")
        self.assertEqual(found, [])
        self.assertNotEqual(err, "")


class SendCommandTest(unittest.TestCase):
    def test_pi_passes_the_transcript_path(self):
        session = {
            "client": "pi",
            "id": "01a17814-ad50-775e-8c08-6ff8df765b64",
            "path": "/home/shay/.pi/agent/sessions/--home-shay--/x.jsonl",
        }
        self.assertEqual(
            buddy_todo.send_command("pi", session, "继续"),
            [
                "pi",
                "-p",
                "--session",
                "/home/shay/.pi/agent/sessions/--home-shay--/x.jsonl",
                "--",
                "继续",
            ],
        )

    def test_opencode_uses_run_with_prompt(self):
        session = {"client": "opencode", "id": "ses_e8f1b3e2cffeh5"}
        self.assertEqual(
            buddy_todo.send_command("opencode", session, "继续"),
            ["opencode", "run", "-s", "ses_e8f1b3e2cffeh5", "--prompt", "继续"],
        )

    def test_new_pi_session_uses_session_id(self):
        session = {"client": "pi", "id": "new-id", "new": True}
        self.assertEqual(
            buddy_todo.send_command("pi", session, "继续"),
            ["pi", "-p", "--session-id", "new-id", "--", "继续"],
        )


class ArchiveTest(unittest.TestCase):
    def test_success_archives_the_todo(self):
        with tempfile.TemporaryDirectory() as tmp:
            todo = pathlib.Path(tmp) / ".buddy-todo.md"
            todo.write_text("# 测试\n继续\n", encoding="utf-8")
            session = {
                "client": "pi",
                "id": "01a17814-ad50-775e-8c08-6ff8df765b64",
                "path": str(pathlib.Path(tmp) / "t.jsonl"),
            }
            calls = []

            def fake_run(argv, cwd=None, timeout=None):
                calls.append(argv)
                return 0, "", ""

            code, _reason = buddy_todo.deliver(
                todo, "pi", session, "# 测试\n继续\n", runner=fake_run
            )
            self.assertEqual(code, 0)
            self.assertEqual(len(calls), 1)
            self.assertFalse(todo.exists())
            archived = list(pathlib.Path(tmp).glob(".buddy-todo.sent-*.md"))
            self.assertEqual(len(archived), 1)
            self.assertEqual(archived[0].read_text(encoding="utf-8"), "# 测试\n继续\n")

    def test_failure_keeps_the_todo(self):
        with tempfile.TemporaryDirectory() as tmp:
            todo = pathlib.Path(tmp) / ".buddy-todo.md"
            todo.write_text("# 测试\n继续\n", encoding="utf-8")
            session = {
                "client": "pi",
                "id": "01a17814-ad50-775e-8c08-6ff8df765b64",
                "path": str(pathlib.Path(tmp) / "t.jsonl"),
            }

            def fake_run(argv, cwd=None, timeout=None):
                return 1, "", "No session found matching ..."

            code, _reason = buddy_todo.deliver(
                todo, "pi", session, "# 测试\n继续\n", runner=fake_run
            )
            self.assertEqual(code, buddy_todo.EXIT_SEND_FAILED)
            self.assertTrue(todo.exists())
            self.assertEqual(list(pathlib.Path(tmp).glob(".buddy-todo.sent-*.md")), [])

    def test_dry_run_sends_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            todo = pathlib.Path(tmp) / ".buddy-todo.md"
            todo.write_text("继续", encoding="utf-8")
            session = {
                "client": "pi",
                "id": "x",
                "path": str(pathlib.Path(tmp) / "t.jsonl"),
            }

            def fake_run(argv, cwd=None, timeout=None):
                raise AssertionError("dry-run 不该跑命令")

            code, _reason = buddy_todo.deliver(
                todo, "pi", session, "继续", dry_run=True, runner=fake_run
            )
            self.assertEqual(code, 0)
            self.assertTrue(todo.exists())


class SyncCheckTest(unittest.TestCase):
    def test_different_field_reports_both_numbers(self):
        gateway = buddy_sync.canonical_gateway_models(
            [("random-work", "随机，能用就行", [], 1000000, 65536)]
        )
        local = {"random-work": {"display_name": "随机，能用就行", "context_window": 1000000, "max_output_tokens": 131072}}
        diffs = buddy_sync.compare_models(gateway, local)
        self.assertEqual(diffs, ["random-work max_output_tokens: 网关 65536 / 本地 131072"])

    def test_identical_models_report_nothing(self):
        gateway = buddy_sync.canonical_gateway_models(
            [("random-work", "随机，能用就行", [], 1000000, 65536)]
        )
        local = {"random-work": {"display_name": "随机，能用就行", "context_window": 1000000, "max_output_tokens": 65536}}
        self.assertEqual(buddy_sync.compare_models(gateway, local), [])

    def test_missing_and_extra_models_are_reported(self):
        gateway = buddy_sync.canonical_gateway_models([("a", "A", [], 1, 2)])
        local = {"b": {"display_name": "B", "context_window": 1, "max_output_tokens": 2}}
        diffs = buddy_sync.compare_models(gateway, local)
        self.assertIn("a model: 网关有 / 本地没有", diffs)
        self.assertIn("b model: 网关没有 / 本地有", diffs)

    def test_opencode_and_pi_configs_normalize_to_the_same_fields(self):
        opencode_cfg = {
            "providers": {
                "buddy": {
                    "models": {
                        "random-work": {
                            "name": "随机，能用就行",
                            "limit": {"context": 1000000, "output": 65536},
                        }
                    }
                }
            }
        }
        pi_cfg = {
            "providers": {
                "buddy": {
                    "models": [
                        {
                            "id": "random-work",
                            "name": "随机，能用就行",
                            "contextWindow": 1000000,
                            "maxTokens": 65536,
                        }
                    ]
                }
            }
        }
        gateway = buddy_sync.canonical_gateway_models(
            [("random-work", "随机，能用就行", [], 1000000, 65536)]
        )
        self.assertEqual(
            buddy_sync.compare_models(gateway, buddy_sync.canonical_opencode_models(opencode_cfg, "buddy")),
            [],
        )
        self.assertEqual(
            buddy_sync.compare_models(gateway, buddy_sync.canonical_pi_models(pi_cfg, "buddy")),
            [],
        )


if __name__ == "__main__":
    unittest.main()
