#!/usr/bin/python3
"""Control and diagnostics CLI for the iOS Safari Debug Stack."""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen

VERSION_FILE = Path("/usr/share/ios-safari-debug-stack/VERSION.json")
SOURCE_VERSION_FILE = Path(__file__).resolve().parents[1] / "VERSION.json"
WIP_SERVICE = "ios-safari-debug-wip.service"
UI_SERVICE = "ios-safari-debug-ui.service"
CDP_SERVICE = "ios-safari-debug-cdp.service"


def run(*args: str, timeout: int = 10) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def systemctl(*args: str) -> subprocess.CompletedProcess[str]:
    return run("systemctl", *args, timeout=30)


def active(service: str) -> bool:
    return systemctl("is-active", "--quiet", service).returncode == 0


def backend() -> str:
    if active(CDP_SERVICE):
        return "cdp"
    if active(WIP_SERVICE):
        return "wip"
    return "stopped"


def fetch_json(url: str, timeout: float = 3.0) -> Any:
    with urlopen(url, timeout=timeout) as response:
        return json.load(response)


def masked_udid(udid: str) -> str:
    return f"…{udid[-6:]}" if len(udid) > 6 else udid


def load_version() -> dict[str, Any]:
    for path in (VERSION_FILE, SOURCE_VERSION_FILE):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
    return {"stack": "development"}


def cmd_version(_: argparse.Namespace) -> int:
    version = load_version()
    print(f"ios-safari-debug-stack {version.get('stack', 'unknown')}")
    for key in ("ios_webkit_debug_proxy", "inspect_webkit", "web_inspector_commit"):
        if key in version:
            print(f"{key}: {version[key]}")
    return 0


def cmd_status(_: argparse.Namespace) -> int:
    selected = backend()
    print(f"backend: {selected}")
    for service in (WIP_SERVICE, UI_SERVICE, CDP_SERVICE, "usbmuxd.service"):
        print(f"{service}: {'active' if active(service) else 'inactive'}")
    if selected == "wip":
        print("discovery: http://127.0.0.1:9221/json")
        print("human UI: http://127.0.0.1:8080/")
    elif selected == "cdp":
        print("CDP: http://127.0.0.1:9333/json/version")
    return 0 if selected != "stopped" else 3


def check(results: list[dict[str, Any]], name: str, ok: bool, detail: str) -> None:
    results.append({"name": name, "ok": ok, "detail": detail})


def os_release() -> dict[str, str]:
    result: dict[str, str] = {}
    try:
        for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                result[key] = value.strip('"')
    except OSError:
        pass
    return result


def cmd_doctor(args: argparse.Namespace) -> int:
    results: list[dict[str, Any]] = []
    release = os_release()
    supported_os = release.get("ID") == "ubuntu" and release.get("VERSION_ID") in {"24.04", "26.04"}
    check(
        results,
        "operating_system",
        supported_os,
        f"{release.get('PRETTY_NAME', platform.platform())} ({platform.machine()})",
    )

    usbmux_socket = Path("/var/run/usbmuxd")
    check(results, "usbmuxd_socket", usbmux_socket.exists(), str(usbmux_socket))
    check(results, "usbmuxd_service", active("usbmuxd.service"), "system service")

    selected = backend()
    check(results, "debug_backend", selected in {"wip", "cdp"}, selected)

    devices: list[str] = []
    if shutil.which("idevice_id"):
        listed = run("idevice_id", "-l")
        devices = [line.strip() for line in listed.stdout.splitlines() if line.strip()]
        check(results, "usb_device", bool(devices), f"{len(devices)} device(s)")
    else:
        check(results, "usb_device", False, "idevice_id is not installed")

    pairing_ok = bool(devices)
    pair_details: list[str] = []
    for udid in devices:
        paired = run("idevicepair", "-u", udid, "validate")
        ok = paired.returncode == 0 and "SUCCESS" in (paired.stdout + paired.stderr)
        pairing_ok = pairing_ok and ok
        pair_details.append(f"{masked_udid(udid)}={'trusted' if ok else 'not trusted'}")
    check(results, "device_pairing", pairing_ok, ", ".join(pair_details) or "no device")

    protocol_ready = False
    try:
        if selected == "wip":
            proxy_devices = fetch_json("http://127.0.0.1:9221/json")
            pages = []
            for device in proxy_devices:
                endpoint = str(device.get("url", ""))
                if endpoint:
                    pages.extend(fetch_json(f"http://{endpoint}/json"))
            protocol_ready = bool(pages)
            check(results, "inspectable_page", protocol_ready, f"{len(pages)} WIP page(s)")
        elif selected == "cdp":
            version = fetch_json("http://127.0.0.1:9333/json/version")
            pages = fetch_json("http://127.0.0.1:9333/json/list")
            protocol_ready = bool(version.get("webSocketDebuggerUrl")) and bool(pages)
            check(results, "inspectable_page", protocol_ready, f"{len(pages)} CDP page(s)")
        else:
            check(results, "inspectable_page", False, "no backend is active")
    except (OSError, URLError, ValueError, json.JSONDecodeError) as error:
        check(results, "inspectable_page", False, str(error))

    if args.json:
        print(json.dumps({"ready": all(item["ok"] for item in results), "checks": results}, indent=2))
    else:
        for item in results:
            print(f"[{'ok' if item['ok'] else '!!'}] {item['name']}: {item['detail']}")

    if selected == "stopped" or not active("usbmuxd.service"):
        return 3
    return 0 if protocol_ready and pairing_ok and supported_os else 2


def require_root() -> None:
    if os.geteuid() != 0:
        raise PermissionError("backend changes require root; rerun with sudo")


def checked_systemctl(*args: str) -> None:
    result = systemctl(*args)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip() or "systemctl failed")


def wait_for_backend(target: str, timeout: float = 15.0) -> None:
    url = (
        "http://127.0.0.1:9333/json/version"
        if target == "cdp"
        else "http://127.0.0.1:9221/json"
    )
    deadline = time.monotonic() + timeout
    last_error = "endpoint did not become ready"
    while time.monotonic() < deadline:
        try:
            fetch_json(url, timeout=1.0)
            return
        except (OSError, URLError, ValueError, json.JSONDecodeError) as error:
            last_error = str(error)
            time.sleep(0.25)
    raise RuntimeError(f"{target} backend failed readiness check: {last_error}")


def switch_backend(target: str) -> None:
    require_root()
    if target == "cdp":
        checked_systemctl("disable", "--now", UI_SERVICE, WIP_SERVICE)
        try:
            checked_systemctl("enable", "--now", CDP_SERVICE)
            wait_for_backend("cdp")
        except Exception:
            systemctl("disable", "--now", CDP_SERVICE)
            systemctl("enable", "--now", WIP_SERVICE, UI_SERVICE)
            raise
    else:
        checked_systemctl("disable", "--now", CDP_SERVICE)
        try:
            checked_systemctl("enable", "--now", WIP_SERVICE, UI_SERVICE)
            wait_for_backend("wip")
        except Exception:
            systemctl("disable", "--now", WIP_SERVICE, UI_SERVICE)
            raise


def cmd_backend(args: argparse.Namespace) -> int:
    if args.backend_command == "get":
        print(backend())
        return 0
    try:
        switch_backend(args.target)
    except (PermissionError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 3
    print(f"active backend: {args.target}")
    return 0


def cmd_ui(_: argparse.Namespace) -> int:
    if not active(WIP_SERVICE):
        print("error: the human UI requires the WIP backend", file=sys.stderr)
        print("run: sudo ios-safari-debug backend set wip", file=sys.stderr)
        return 3
    url = "http://127.0.0.1:8080/"
    if shutil.which("xdg-open") and os.environ.get("DISPLAY"):
        result = run("xdg-open", url)
        if result.returncode == 0:
            return 0
    if webbrowser.open(url):
        return 0
    print(url)
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="ios-safari-debug")
    commands = root.add_subparsers(dest="command", required=True)

    status = commands.add_parser("status", help="show services and endpoints")
    status.set_defaults(func=cmd_status)

    doctor = commands.add_parser("doctor", help="verify the complete USB debugging path")
    doctor.add_argument("--json", action="store_true", help="emit machine-readable results")
    doctor.set_defaults(func=cmd_doctor)

    backend_parser = commands.add_parser("backend", help="inspect or switch protocol backend")
    backend_commands = backend_parser.add_subparsers(dest="backend_command", required=True)
    backend_get = backend_commands.add_parser("get")
    backend_get.set_defaults(func=cmd_backend)
    backend_set = backend_commands.add_parser("set")
    backend_set.add_argument("target", choices=("wip", "cdp"))
    backend_set.set_defaults(func=cmd_backend)

    ui = commands.add_parser("ui", help="open the bundled Web Inspector")
    ui.set_defaults(func=cmd_ui)

    version = commands.add_parser("version", help="print component versions")
    version.set_defaults(func=cmd_version)
    return root


def main() -> int:
    try:
        args = parser().parse_args()
        return int(args.func(args))
    except subprocess.TimeoutExpired as error:
        print(f"error: command timed out: {error.cmd}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
