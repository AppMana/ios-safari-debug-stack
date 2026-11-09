# iOS Safari Debug Stack

Local USB debugging stack for Mobile Safari on Ubuntu (`24.04` Noble and `26.04` Resolute).

## Overview

`ios-safari-debug-stack` exposes Safari tabs on USB-attached iPhones and iPads over `127.0.0.1`:

- **WebKit Inspector Proxy (`wip`, default)**: Runs `ios_webkit_debug_proxy` on `127.0.0.1:9221` (`9222–9322` per device) for [`iwdp-mcp`](https://github.com/nnemirovsky/iwdp-mcp) and serves a bundled WebKit Web Inspector UI at `http://127.0.0.1:8080/`.
- **Chrome DevTools Protocol Bridge (`cdp`)**: Runs `ios-safari-cdp-bridge` on `127.0.0.1:9333` for `chrome://inspect`, Puppeteer, and [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp).
- **Single-Client Evaluation Service (`ios-safari-debug-evaluate`)**: Optional HTTP endpoint on `127.0.0.1:9334` that maintains a single persistent CDP session to a configured `SAFARI_TARGET_URL` and reconnects across USB resets.
- **USB & Pairing Stability**: Requires AppMana's patched [`usbmuxd`](https://github.com/AppMana/forks-usbmuxd-ios), disables destructive lockdown preflight deletion of `/var/lib/lockdown` trust records, removes systemd start-rate lockouts on `usbmuxd.service`, disables SuperSpeed USB3 U1/U2 link power management and USB autosuspend on attached iOS devices, and prevents `ipheth` USB tethering, `apple_mfi_fastcharge`, `ModemManager`, and `mtp-probe` from resetting iOS USB connections.

All debugging listeners bind strictly to `127.0.0.1`. Only one backend (`wip` or `cdp`) runs at a time because Mobile Safari allows one active inspector session per page.

## Install

### From AppMana APT (Ubuntu 24.04 amd64)

```sh
curl -fsSL https://appmana.github.io/apt/appmana-archive-keyring.gpg \
  | sudo gpg --dearmor --yes -o /usr/share/keyrings/appmana-archive-keyring.gpg
echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/appmana-archive-keyring.gpg] https://appmana.github.io/apt noble main' \
  | sudo tee /etc/apt/sources.list.d/appmana.list
sudo apt update
sudo apt install ios-safari-debug-stack
```

### Offline `.deb` Install

Download matching `usbmuxd_*.deb` and `ios-safari-debug-stack_*.deb` packages from GitHub Releases and install both together:

```sh
sudo apt install ./usbmuxd_*.deb ./ios-safari-debug-stack_*.deb
```

### Device Setup

1. Connect the iPhone or iPad over USB and pair it once:
   ```sh
   idevice_id -l
   idevicepair -u <UDID> pair
   ```
   Tap **Trust** on the device when prompted, then re-run `idevicepair -u <UDID> pair` if needed.
2. On the device, enable **Settings → Apps → Safari → Advanced → Web Inspector**.
3. Keep the device unlocked with a Safari tab open, then verify:
   ```sh
   ios-safari-debug doctor
   ios-safari-debug status
   ```

## Usage

### CLI & Endpoints

| Command / Endpoint | Description |
| --- | --- |
| `ios-safari-debug doctor [--json]` | Check OS, `usbmuxd`, USB enumeration, pairing trust, and inspectable tabs |
| `ios-safari-debug status` | Show active backend, service states, and local URLs |
| `ios-safari-debug pages --udid <UDID>` | List inspectable tabs for a specific device UDID |
| `ios-safari-debug backend get` | Print `wip`, `cdp`, or `stopped` |
| `sudo ios-safari-debug backend set wip\|cdp` | Switch between raw WebKit Inspector and CDP backends |
| `ios-safari-debug ui` | Open the bundled Web Inspector (`http://127.0.0.1:8080/`, requires `wip`) |
| `127.0.0.1:9221` / `9222–9322` | `wip` device list and per-device inspector endpoints |
| `127.0.0.1:9333` | `cdp` discovery (`/json/version`, `/json/list`) and WebSocket endpoint |
| `127.0.0.1:9334` | Optional single-client JavaScript evaluation service (`GET /health`, `POST /`) |
| `127.0.0.1:8080` | Bundled WebKit Web Inspector UI |

### Raw WebKit Backend (`wip`)

Enabled by default after installation:

```sh
sudo ios-safari-debug backend set wip
ios-safari-debug ui
```

Compatible with `iwdp-cli` / `iwdp-mcp` against `127.0.0.1:9221`. When multiple iOS devices are attached, resolve targets by UDID with `ios-safari-debug pages --udid <UDID>` rather than assuming fixed port numbers.

### Chrome DevTools Protocol Backend (`cdp`)

Switch to the CDP bridge for `chrome://inspect` (`localhost:9333`), `chrome-devtools-mcp`, or Puppeteer:

```sh
sudo ios-safari-debug backend set cdp
npx -y chrome-devtools-mcp --browserUrl=http://127.0.0.1:9333
```

Puppeteer example:

```js
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({
  browserURL: 'http://127.0.0.1:9333',
  protocolTimeout: 15000,
});
const [page] = await browser.pages();
await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
console.log(await page.evaluate(() => document.title));
await browser.disconnect();
```

### Persistent Single-Client Evaluation Service (`9334`)

To evaluate JavaScript over HTTP without opening competing inspector WebSockets:

1. Set `SAFARI_TARGET_URL=https://your-site.example/` in `/etc/ios-safari-debug/evaluate.env`.
2. Enable the CDP backend and start the evaluator:
   ```sh
   sudo ios-safari-debug backend set cdp
   sudo systemctl enable --now ios-safari-debug-evaluate
   curl -s http://127.0.0.1:9334/health
   curl -s -X POST http://127.0.0.1:9334 -d 'document.title'
   ```

## Limitations

- Mobile Safari allows one inspector client per tab; disconnect other clients before attaching a new tool.
- Playwright `connectOverCDP` can enumerate targets, but page-level APIs (`page.evaluate`, `page.goto`, locators) require isolated utility worlds that WebKit does not support. Use Puppeteer, `chrome-devtools-mcp`, or `127.0.0.1:9334`.
- Safari's Web Inspector protocol does not support creating/closing tabs (`Target.createTarget`), response body capture, or CDP screenshots.
- Device unlock, initial USB trust, and the Safari Web Inspector toggle must be enabled manually on the iOS device.

## Build from Source

```sh
sudo apt build-dep .
dpkg-buildpackage -us -uc -b
```

Builds are offline; vendored components and licenses are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
