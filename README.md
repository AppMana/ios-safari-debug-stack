# iOS Safari Debug Stack for Ubuntu

Installs a local-only Mobile Safari debugging stack. AppMana APT currently
publishes the stack and patched `usbmuxd` for Ubuntu 24.04 (Noble), amd64.
The patched daemon upgrades Ubuntu's `usbmuxd` in place; `libimobiledevice`,
`libplist`, and `libusbmuxd` remain the distribution libraries.

The default backend is the mature raw WebKit Inspector path used by
[`iwdp-mcp`](https://github.com/nnemirovsky/iwdp-mcp). A selectable CDP bridge
lets Chrome DevTools and
[`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)
connect to the same iPad or iPhone. A patched WebKit Web Inspector is bundled
for humans at `http://127.0.0.1:8080/`.

## Install

Add the signed AppMana repository and install through APT:

```sh
curl -fsSL https://appmana.github.io/apt/appmana-archive-keyring.gpg \
  | sudo gpg --dearmor --yes -o /usr/share/keyrings/appmana-archive-keyring.gpg
echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/appmana-archive-keyring.gpg] https://appmana.github.io/apt noble main' \
  | sudo tee /etc/apt/sources.list.d/appmana.list
sudo apt update
sudo apt install ios-safari-debug-stack
```

This also installs `usbmuxd >= 1.1.1-5~exp3ubuntu2.1+appmana2`. The AppMana
build keeps the **same package name**, executable paths, udev rules and systemd
service as Ubuntu's daemon. Its higher version makes this a normal in-place
upgrade: there is one daemon, not two competing installations. A `Replaces`
field is unnecessary for an upgrade of the same package. No forced overwrite,
manual removal, package hold, or deletion of pairing records is needed.

The [daemon fork](https://github.com/AppMana/forks-usbmuxd-ios/tree/appmana/ubuntu-noble)
backports upstream's reentrant-client-close fix and restarts the service after
abnormal process termination. It retains Ubuntu's security patches. Upgrading
the daemon briefly disconnects inspector sessions; the bridge reconnects.
Verify the selected and installed versions with `apt-cache policy usbmuxd` and
`dpkg-query -W usbmuxd ios-safari-debug-stack`.

For offline installation, download **both** matching `.deb` files from the
two repositories' releases and run `sudo apt install ./usbmuxd_*.deb
./ios-safari-debug-stack_*.deb`. The daemon is a required dependency, not an
optional follow-up installation.

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
evaluation, navigation, DOM/resource-tree inspection, and semantic
`take_snapshot` output. The bridge translates Puppeteer's execution-context
form of `Runtime.callFunctionOn` and synthesizes Chrome's accessibility tree
from WebKit DOM data.

Puppeteer (`puppeteer-core` 25.11) attaches directly. `puppeteer.connect`,
`browser.pages()`, `page.goto()` and `page.evaluate()` are verified against a
physical iPhone on iOS 27:

```js
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({
  browserURL: 'http://127.0.0.1:9333',
  protocolTimeout: 15000,
});
const [page] = await browser.pages();
await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
console.log(await page.evaluate(() => document.title));
// Point-and-click input is experimental; drive interaction from the page.
await page.evaluate(() => document.querySelector('#start')?.click());
await browser.disconnect();
```

`defaultViewport: null` is no longer required, and no `targetFilter` is needed:
only `page` targets are discovered and auto-attached.

Playwright's `chromium.connectOverCDP('http://127.0.0.1:9333')` connects and
enumerates the browser context and its pages. Page-level APIs
(`page.evaluate`, locators, `page.goto`) do not work: Playwright runs them in
an isolated "utility world" that it asks for with
`Page.addScriptToEvaluateOnNewDocument({worldName})`, and WebKit cannot create
one. The bridge does not pass the page's main world off as an isolated world,
so those calls wait on a world that never appears. Use Puppeteer or
`chrome-devtools-mcp` for page automation.

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
| `ios-safari-debug pages --udid <UDID>` | Resolve current pages through the active backend |
| `ios-safari-debug backend get` | Print `wip`, `cdp`, or `stopped` |
| `sudo ios-safari-debug backend set wip\|cdp` | Atomically switch services |
| `ios-safari-debug ui` | Open the bundled human inspector |
| `127.0.0.1:9221` / `9222-9322` | IWDP device and page endpoints |
| `127.0.0.1:9333` | CDP discovery and browser WebSocket |
| `127.0.0.1:9334` | Optional reconnecting single-client evaluation endpoint |
| `127.0.0.1:8080` | Human Web Inspector |

## Downstream hardening

- IWDP v1.9.2 is patched for GCC 15/glibc 2.43 const correctness and forced
  to bind to IPv4 loopback instead of `INADDR_ANY`.
- `inspect-webkit` is forced to preserve loopback binding and excludes Safari
  extension/background targets, service workers and dedicated workers by
  default. Those targets accept an inspector connection but never answer the
  page-shaped boot sequence, so Puppeteer and Chrome DevTools MCP auto-attached
  and failed during `Network.enable`. Pass `--include-extension-targets` to see
  them. Safari's `WIRTypeKey` is mapped exactly; an unrecognised type is
  reported as `other`, never as `page`.
- The bridge treats a Web Inspector tunnel that has stopped carrying traffic as
  dead. Each device is heartbeated every 1.5s with
  `_rpc_getConnectedApplications:`; 12s of silence, or a transport close, drops
  the device, purges its cached page listing, fails every open CDP session with
  an explicit error, and closes those sockets with a reason. The device is then
  re-attached by UDID without restarting the service. Before this, a half-open
  USB tunnel left `/json/list` advertising pages from a Safari process that no
  longer existed, and every command to them vanished without a reply.
- Every CDP command carries a 30s watchdog. If Safari does not answer — a WIR
  session invalidated by a navigation, a page claimed by another debugger, a
  wedged inner target — the client gets an explicit protocol error naming the
  app and page. A target never silently drops a command. The ceiling is
  deliberately generous: a page running heavy work on its main thread cannot
  execute an evaluate until it yields. Tune it with
  `INSPECT_WEBKIT_COMMAND_TIMEOUT_MS`.
- iOS 27 removed `Page.navigate` and `Page.setTouchEmulationEnabled` from
  WebKit's Page domain. The bridge probes `Page.navigate` once per session and
  otherwise performs the navigation from inside the page, answering with the
  frame and loader ids that the resulting `Page.frameNavigated` carries.
  Touch emulation is acked: the inspected device is a real touch device and
  the inspector cannot change that.
- Discovery tolerates a trailing slash (`/json/version/`, `/json/list/`), which
  is what Playwright requests.
- The CDP adapter translates Puppeteer's main/utility-world calls and builds a
  resolvable semantic accessibility tree for MCP snapshots, although WebKit
  has no native Chrome Accessibility domain.
- The human frontend chooses the closest bundled iOS protocol definition from
  the connected device version, with no first-run Git checkout.

## Known limitations

- Safari's protocol does not expose Chrome-equivalent response bodies or page
  screenshots. CDP clients receive explicit errors for unsupported commands.
- Opening, closing and isolating tabs is not possible over WIR.
  `Target.createTarget`, `Target.closeTarget`'s browser-context siblings and
  `Browser.close` return explicit `-32601` errors.
- Downloads cannot be controlled. `Browser.setDownloadBehavior` is accepted so
  Playwright's connect sequence completes, but it has no effect.
- Playwright page automation is unsupported (see above); connection and target
  enumeration work.
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

### USB discovery versus inspector discovery

`ios-safari-debug pages --udid <UDID>` uses the active WIP or CDP backend.
For CDP it matches the device component of target IDs exactly; it never selects
another connected device or simulator when the requested device is absent.

If `lsusb` sees an Apple device but `timeout 5 idevice_id -l` cannot enumerate
it, the failure is below the inspector bridge. Restarting the bridge cannot
repair a stalled usbmuxd. Do not delete pairing records or assume a mounted
photo volume proves a USB interface conflict.

For a responsive usbmuxd with missed device discovery, its existing systemd
mode supports a rescan without restarting:

```sh
sudo systemctl kill --kill-who=main --signal=SIGUSR2 usbmuxd.service
timeout 5 idevice_id -l
```

This signal schedules `usb_discover()` in the daemon's event loop; existing
enumerated devices are retained. It cannot recover an event loop stuck in USB
teardown. SIGUSR1 requests exit and is **not** the rescan signal. Never send
signals to an arbitrary process; the command targets the service main process.

On September 21, 2026, this host's usbmuxd 1.1.1-5~exp3ubuntu2.1 logged an iPad
attach followed 12 ms later by removal and “Cannot find device entry while
removing USB device.” A later stop waited 90 seconds and required SIGKILL.
The daemon masks SIGTERM and SIGUSR2 outside its main `ppoll()` call, so this
is consistent with a stuck USB processing/teardown path, rather than a missing
CDP page. The old process was already gone before a stack trace could be taken;
the exact blocking call and any role of the desktop photo mount remain unproven.
The kernel also loaded `apple-mfi-fastcharge` at the initial attach; a device
driver rebinding/configuration race is another candidate trigger. Upstream
[issue 163](https://github.com/libimobiledevice/usbmuxd/issues/163) reports the
same log sequence and discusses this driver. No kernel driver settings were
changed on this host during the investigation.

Upstream [issue 114](https://github.com/libimobiledevice/usbmuxd/issues/114)
describes this class of teardown hang and links
[fix 63d1164](https://github.com/libimobiledevice/usbmuxd/commit/63d1164e736d7419198d1b737d10a9aae85bef98).
Inspection of the exact installed Ubuntu source confirms that fix is absent.
The AppMana daemon package includes this fix. Its regression fails on the stock
source and passes on the patched source, including memory-sanitizer checks.
Physical-iPad tests verified recovery after a forced daemon failure and after
a paused USB transport resumed, without manually restarting either bridge
process or changing pairing records. This does not establish the cause of every
USB hang; preserve the journal and daemon stacks if another failure occurs.

USB, lockdown and TLS handshakes have bounded deadlines so an unresponsive
daemon cannot occupy discovery forever. For automated evaluation, configure
`SAFARI_TARGET_URL=https://your-site.example/` in
`/etc/ios-safari-debug/evaluate.env`, switch to the CDP backend, then run
`sudo systemctl enable --now ios-safari-debug-evaluate`. The endpoint at
`http://127.0.0.1:9334` accepts JavaScript in a POST body and exposes `/health`.
It rediscovers the actual Safari target after disconnects, rejects ambiguous
tabs, and never automatically replays a timed-out command. Use this endpoint
instead of opening an additional inspector client for the same page.
