# iOS Safari Debug Stack for Ubuntu

One `.deb` installs and prepares a local-only Mobile Safari debugging stack for
Ubuntu 24.04 and 26.04. It uses Ubuntu's `usbmuxd`, `libimobiledevice`,
`libplist`, and `libusbmuxd` packages rather than replacing them.

The default backend is the mature raw WebKit Inspector path used by
[`iwdp-mcp`](https://github.com/nnemirovsky/iwdp-mcp). A selectable CDP bridge
lets Chrome DevTools and
[`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)
connect to the same iPad or iPhone. A patched WebKit Web Inspector is bundled
for humans at `http://127.0.0.1:8080/`.

## Install

Download the `.deb` matching the Ubuntu release and CPU architecture, then use
APT so distro dependencies are resolved:

```sh
sudo apt install ./ios-safari-debug-stack_*.deb
```

On the iPhone or iPad:

1. Connect with USB and accept **Trust This Computer**.
2. Enable **Settings → Apps → Safari → Advanced → Web Inspector**.
3. Unlock the device and open at least one normal Safari page.

Verify the complete path:

```sh
ios-safari-debug doctor
ios-safari-debug status
```

The package starts the WIP backend and human UI after a fresh install. All
debugging listeners are restricted to loopback because they permit arbitrary
JavaScript execution in the inspected page.

## MCP and browser clients

The package deliberately does not install an MCP server.

Raw WIP, tested with `iwdp-mcp` 0.5.3:

```sh
iwdp-cli devices
iwdp-cli eval 'document.title'
```

`iwdp-mcp` uses the default discovery service at `127.0.0.1:9221` without
additional arguments.

Chrome DevTools Protocol, tested with `chrome-devtools-mcp` 1.8.0:

```sh
sudo ios-safari-debug backend set cdp
npx -y chrome-devtools-mcp@1.8.0 \
  --browserUrl=http://127.0.0.1:9333
```

Chrome can discover the same endpoint from `chrome://inspect` after adding
`localhost:9333`. Return to the reliable raw backend with:

```sh
sudo ios-safari-debug backend set wip
ios-safari-debug ui
```

Only one backend runs at a time because Mobile Safari permits a single active
inspector connection per page.

## Commands and endpoints

| Interface | Purpose |
| --- | --- |
| `ios-safari-debug doctor [--json]` | USB, pairing, service, and page checks |
| `ios-safari-debug backend get` | Print `wip`, `cdp`, or `stopped` |
| `sudo ios-safari-debug backend set wip\|cdp` | Atomically switch services |
| `ios-safari-debug ui` | Open the bundled human inspector |
| `127.0.0.1:9221` / `9222-9322` | IWDP device and page endpoints |
| `127.0.0.1:9333` | CDP discovery and browser WebSocket |
| `127.0.0.1:8080` | Human Web Inspector |

## Downstream hardening

- IWDP v1.9.2 is patched for GCC 15/glibc 2.43 const correctness and forced
  to bind to IPv4 loopback instead of `INADDR_ANY`.
- `inspect-webkit` is forced to preserve loopback binding and excludes Safari
  extension/background targets by default. Those targets caused Puppeteer and
  Chrome DevTools MCP to auto-attach and fail during `Network.enable`.
- The human frontend chooses the closest bundled iOS protocol definition from
  the connected device version, with no first-run Git checkout.

## Known limitations

- Safari's protocol does not expose Chrome-equivalent response bodies or page
  screenshots. CDP clients receive explicit errors for unsupported commands.
- Canvas and some Timeline features remain limited in the human inspector.
- Trust, unlock, and the Web Inspector device setting cannot be automated.
- Appium RemoteXPC is not included in v1 because it requires a privileged
  TUN/TAP tunnel. It is the planned fallback if a future iOS version removes
  the current USB Web Inspector service.

## Build

```sh
sudo apt build-dep .
dpkg-buildpackage -us -uc -b
```

The build is network-free. Vendored sources and versions are documented in
[THIRD_PARTY.md](THIRD_PARTY.md).
