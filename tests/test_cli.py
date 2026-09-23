from __future__ import annotations

import importlib.util
import io
import unittest
from argparse import Namespace
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from unittest.mock import MagicMock, patch


MODULE_PATH = Path(__file__).parents[1] / "src" / "ios_safari_debug.py"
SPEC = importlib.util.spec_from_file_location("ios_safari_debug", MODULE_PATH)
assert SPEC and SPEC.loader
cli = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cli)


class CliTests(unittest.TestCase):
    @patch.object(cli, "backend", return_value="cdp")
    @patch.object(cli, "fetch_json")
    def test_cdp_pages_selects_exact_device(self, fetch: MagicMock, _: MagicMock) -> None:
        ipad = {"id": "device:ipad:PID:123:4", "url": "https://example.com"}
        fetch.return_value = [
            {"id": "device:ipad-other:PID:123:4"},
            {"id": "sim:ipad:PID:123:4"}, ipad,
        ]
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(cli.cmd_pages(Namespace(udid="ipad")), 0)
        self.assertEqual(cli.json.loads(output.getvalue()), [ipad])
        fetch.assert_called_once_with("http://127.0.0.1:9333/json/list")

    @patch.object(cli, "backend", return_value="cdp")
    @patch.object(cli, "fetch_json", return_value=[{"id": "device:phone:PID:123:4"}])
    def test_cdp_missing_device_fails(self, _: MagicMock, _backend: MagicMock) -> None:
        with redirect_stderr(io.StringIO()):
            self.assertEqual(cli.cmd_pages(Namespace(udid="ipad")), 2)

    @patch.object(cli, "backend", return_value="stopped")
    @patch.object(cli, "fetch_json")
    def test_pages_stopped_backend_does_not_fetch(self, fetch: MagicMock, _: MagicMock) -> None:
        with redirect_stderr(io.StringIO()):
            self.assertEqual(cli.cmd_pages(Namespace(udid="ipad")), 2)
        fetch.assert_not_called()

    @patch.object(cli, "backend", return_value="wip")
    @patch.object(cli, "wip_pages", return_value=[{"id": "ipad-page"}])
    def test_pages_uses_active_wip(self, pages: MagicMock, _: MagicMock) -> None:
        with redirect_stdout(io.StringIO()):
            self.assertEqual(cli.cmd_pages(Namespace(udid="ipad")), 0)
        pages.assert_called_once_with("ipad")

    @patch.object(cli, "fetch_json")
    def test_pages_resolves_device_after_ports_swap(self, fetch: MagicMock) -> None:
        fetch.side_effect = [
            [{"deviceId": "phone", "url": "localhost:9222"}, {"deviceId": "ipad", "url": "localhost:9223"}],
            [{"id": "ipad-page"}],
            [{"deviceId": "ipad", "url": "localhost:9222"}, {"deviceId": "phone", "url": "localhost:9223"}],
            [{"id": "ipad-new-page"}],
        ]
        self.assertEqual(cli.wip_pages("ipad"), [{"id": "ipad-page"}])
        self.assertEqual(cli.wip_pages("ipad"), [{"id": "ipad-new-page"}])
        self.assertEqual(fetch.call_args_list[1].args, ("http://localhost:9223/json",))
        self.assertEqual(fetch.call_args_list[3].args, ("http://localhost:9222/json",))

    @patch.object(cli, "fetch_json", return_value=[{"deviceId": "phone", "url": "localhost:9222"}])
    def test_missing_device_never_selects_another(self, _: MagicMock) -> None:
        with self.assertRaises(ValueError):
            cli.wip_pages("ipad")

    def test_masks_device_identifier(self) -> None:
        self.assertEqual(cli.masked_udid("00008120-001234560123401E"), "…23401E")

    @patch.object(cli, "active")
    def test_backend_prefers_cdp(self, active: MagicMock) -> None:
        active.side_effect = lambda service: service == cli.CDP_SERVICE
        self.assertEqual(cli.backend(), "cdp")

    @patch.object(cli, "fetch_json")
    @patch.object(cli, "run")
    @patch.object(cli, "backend", return_value="wip")
    @patch.object(cli, "active", return_value=True)
    @patch.object(cli, "os_release", return_value={"ID": "ubuntu", "VERSION_ID": "24.04", "PRETTY_NAME": "Ubuntu 24.04"})
    @patch.object(cli.Path, "exists", return_value=True)
    @patch.object(cli.shutil, "which", return_value="/usr/bin/idevice_id")
    def test_doctor_ready(
        self,
        _which: MagicMock,
        _exists: MagicMock,
        _release: MagicMock,
        _active: MagicMock,
        _backend: MagicMock,
        run: MagicMock,
        fetch_json: MagicMock,
    ) -> None:
        def command(*args: str, **_kwargs: object) -> MagicMock:
            if args[:2] == ("idevice_id", "-l"):
                return MagicMock(returncode=0, stdout="example-device\n", stderr="")
            return MagicMock(returncode=0, stdout="SUCCESS: Validated pairing\n", stderr="")

        run.side_effect = command
        fetch_json.side_effect = [
            [{"url": "127.0.0.1:9222"}],
            [{"title": "Example", "url": "https://example.com"}],
        ]
        with redirect_stdout(io.StringIO()):
            self.assertEqual(cli.cmd_doctor(Namespace(json=False)), 0)

    @patch.object(cli, "checked_systemctl")
    @patch.object(cli, "wait_for_backend")
    @patch.object(cli, "require_root")
    def test_switch_to_cdp(
        self,
        _require_root: MagicMock,
        wait: MagicMock,
        systemctl: MagicMock,
    ) -> None:
        cli.switch_backend("cdp")
        self.assertEqual(
            systemctl.call_args_list[0].args,
            ("disable", "--now", cli.UI_SERVICE, cli.WIP_SERVICE),
        )
        self.assertEqual(
            systemctl.call_args_list[1].args,
            ("enable", "--now", cli.CDP_SERVICE),
        )
        wait.assert_called_once_with("cdp")


if __name__ == "__main__":
    unittest.main()
