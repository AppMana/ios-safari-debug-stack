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

1. Connect with USB. For first-time pairing, run `idevicepair -u <UDID> pair`
   (get the UDID with `idevice_id -l`), accept **Trust This Computer**, then
   repeat the pairing command if it reported a pending response.
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

Live-device verification covers page discovery, console messages, JavaScript
evaluation, DOM/resource-tree inspection, and semantic `take_snapshot` output.
The bridge translates Puppeteer's execution-context form of
`Runtime.callFunctionOn` and synthesizes Chrome's accessibility tree from
WebKit DOM data.

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
| `ios-safari-debug pages --udid <UDID>` | Resolve current WIP pages for one device |
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
- The CDP adapter translates Puppeteer's main/utility-world calls and builds a
  resolvable semantic accessibility tree for MCP snapshots, although WebKit
  has no native Chrome Accessibility domain.
- The human frontend chooses the closest bundled iOS protocol definition from
  the connected device version, with no first-run Git checkout.

## Known limitations

- Safari's protocol does not expose Chrome-equivalent response bodies or page
  screenshots. CDP clients receive explicit errors for unsupported commands.
- MCP element snapshots are supported; Puppeteer-style point-and-click input
  remains experimental because Safari does not provide Chrome's isolated-world
  DOM adoption semantics. Use `evaluate_script` for deterministic interaction.
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

## Persistent USB trust

The package installs a `usbmuxd.service` drop-in with `--no-preflight`.
Upstream preflight deletes a saved pairing record on any StartSession SSL
failure, including transport failures during rapid USB disconnect/reconnect.
On this host the September 14 log showed the iPhone disconnect, followed by
“stored pair record … invalid. Removing” and a new trust prompt. The system
configuration file had not changed since May; the iPad record dated from August.
This is evidence of record deletion, not a rotating global host identifier.

The drop-in disables that destructive automatic preflight; clients still use
normal authenticated lockdown sessions. It does not bypass iOS trust. Existing
`/var/lib/lockdown` records and their host identity stay in place. Never delete,
regenerate or commit those records: they contain private keys. A newly connected
unpaired device requires the explicit pairing command above. Revoked trust or a
device reset still requires pairing again.

After installing/upgrading this setting, apply it with:

```sh
sudo systemctl daemon-reload
sudo systemctl restart usbmuxd ios-safari-debug-wip
```

This briefly disconnects inspector sessions. Verify each device independently:
`idevicepair -u <UDID> validate`, then `ios-safari-debug doctor`.
To roll back only this setting, remove the drop-in and repeat the reload/restart.
The package does not modify or remove pairing records on uninstall.

Upstream deletion path:
https://github.com/libimobiledevice/usbmuxd/blob/master/src/preflight.c

When multiple devices are connected, device ports are allocated in connection
order and can swap after reconnects. Resolve pages by UDID on every operation:
`ios-safari-debug pages --udid <UDID>`. Pass the returned
`webSocketDebuggerUrl` explicitly to `iwdp-cli` or the MCP operation; never assume
9222 means iPad or use the first discovered page. A missing UDID fails explicitly
instead of falling back to another device.

The WIP proxy also reconciles USB devices every five seconds. A failed initial
attachment or lost inspector transport is retried by UDID without restarting
healthy device connections. This does not reload Safari pages or reset pairing.
The package build runs a C lifecycle test that simulates a failing phone attach,
successful retry, and later transport loss while preserving the iPad connection.
