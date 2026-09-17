// End-to-end tests for the CDP bridge against an in-process fake Safari
// Web Inspector (see ./fake-wir.ts). These cover the behaviours real
// clients depend on and that regressed against live hardware:
//
//   * Playwright's discovery fetch of `/json/version/` (trailing slash)
//   * Playwright's browser-level handshake (Browser.setDownloadBehavior,
//     Target.getTargetInfo, flatten-mode auto-attach)
//   * Puppeteer's `connect()` + `pages()` + `evaluate()` boot sequence,
//     including the default-viewport emulation calls
//   * service-worker targets staying out of discovery and auto-attach
//   * a target never silently dropping a command

import { test, expect } from "bun:test";
import { WebSocket } from "ws";
import { startCdpServer, type CdpServer, type CdpServerOptions } from "../server";
import { FakeWirDevice, type FakeDeviceOptions } from "./fake-wir";

const PAGE_URL = "https://example.test/puppet";

let nextPort = 19400 + Math.floor(Math.random() * 400);

async function startRig(
  deviceOpts: FakeDeviceOptions = {},
  serverOpts: Partial<CdpServerOptions> = {},
): Promise<{ device: FakeWirDevice; server: CdpServer; port: number; stop: () => void }> {
  const device = new FakeWirDevice(deviceOpts);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 12; attempt++) {
    const port = nextPort++;
    try {
      const server = await startCdpServer({
        host: "127.0.0.1",
        port,
        refreshMs: 40,
        reconnectMs: 40,
        sourceStaleMs: 400,
        commandTimeoutMs: 700,
        discoverSources: async (live) => (live.has(device.asSource().id) ? [] : [device.asSource()]),
        ...serverOpts,
      });
      return { device, server, port, stop: () => server.stop() };
    } catch (e) {
      lastErr = e;
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    }
  }
  throw lastErr;
}

function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await check()) return resolve();
      if (Date.now() > deadline) return reject(new Error("timed out waiting for condition"));
      setTimeout(tick, 20);
    };
    void tick();
  });
}

async function listTargets(port: number): Promise<any[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return (await res.json()) as any[];
}

/** Minimal CDP client over a raw WebSocket. */
class RawCdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (m: any) => void>();
  readonly events: any[] = [];
  closeInfo: { code: number; reason: string } | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw: Buffer) => {
      const m = JSON.parse(raw.toString());
      if (typeof m.id === "number" && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
      } else {
        this.events.push(m);
      }
    });
    ws.on("close", (code: number, reason: Buffer) => {
      this.closeInfo = { code, reason: reason.toString() };
    });
  }

  static open(url: string): Promise<RawCdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once("open", () => resolve(new RawCdp(ws)));
      ws.once("error", reject);
    });
  }

  send(method: string, params: any = {}, extra: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params, ...extra }));
    });
  }

  sendRaw(frame: Record<string, unknown>) {
    this.ws.send(JSON.stringify(frame));
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

// ---------------------------------------------------------------------------

test("discovery tolerates a trailing slash (Playwright connectOverCDP)", async () => {
  const rig = await startRig();
  try {
    const plain = await fetch(`http://127.0.0.1:${rig.port}/json/version`);
    const slashed = await fetch(`http://127.0.0.1:${rig.port}/json/version/`);
    expect(plain.status).toBe(200);
    expect(slashed.status).toBe(200);
    expect(await slashed.json()).toEqual(await plain.json());

    const listSlashed = await fetch(`http://127.0.0.1:${rig.port}/json/list/`);
    expect(listSlashed.status).toBe(200);
  } finally {
    rig.stop();
  }
});

test("service-worker targets are hidden from discovery", async () => {
  const rig = await startRig();
  try {
    await waitFor(async () => (await listTargets(rig.port)).length > 0);
    const targets = await listTargets(rig.port);
    expect(targets).toHaveLength(1);
    expect(targets[0].type).toBe("page");
    expect(targets[0].url).toBe(PAGE_URL);

    const withWorkers = await fetch(`http://127.0.0.1:${rig.port}/json/list`);
    expect((await withWorkers.json()).some((t: any) => t.type === "service_worker")).toBe(false);
  } finally {
    rig.stop();
  }
});

test("raw page session answers enables and evaluate", async () => {
  const rig = await startRig();
  try {
    await waitFor(async () => (await listTargets(rig.port)).length > 0);
    const [target] = await listTargets(rig.port);
    const cdp = await RawCdp.open(target.webSocketDebuggerUrl);
    const results = await Promise.all([
      cdp.send("Runtime.enable"),
      cdp.send("Page.enable"),
      cdp.send("Network.enable"),
      cdp.send("Runtime.evaluate", { expression: "location.href", returnByValue: true }),
    ]);
    for (const r of results) expect(r.error).toBeUndefined();
    expect(results[3].result.result.value).toBe(PAGE_URL);
    cdp.close();
  } finally {
    rig.stop();
  }
});

test("a wedged target fails the command explicitly instead of dropping it", async () => {
  // The fake page swallows Network.enable, reproducing an inspector session
  // that has stopped answering. The bridge must still answer the client.
  const rig = await startRig({
    answer: (method) => (method === "Network.enable" ? null : undefined),
  });
  try {
    await waitFor(async () => (await listTargets(rig.port)).length > 0);
    const [target] = await listTargets(rig.port);
    const cdp = await RawCdp.open(target.webSocketDebuggerUrl);
    const reply = await cdp.send("Network.enable");
    expect(reply.error).toBeDefined();
    expect(reply.error.message).toContain("Network.enable timed out");
    // The session is still usable for everything else.
    const evaluated = await cdp.send("Runtime.evaluate", { expression: "location.href" });
    expect(evaluated.error).toBeUndefined();
    cdp.close();
  } finally {
    rig.stop();
  }
});

test("losing the device tunnel drops its targets and fails open sessions", async () => {
  const rig = await startRig();
  try {
    await waitFor(async () => (await listTargets(rig.port)).length > 0);
    const [target] = await listTargets(rig.port);
    const cdp = await RawCdp.open(target.webSocketDebuggerUrl);
    expect((await cdp.send("Runtime.enable")).error).toBeUndefined();

    // Half-open tunnel: no FIN, no error, just silence. This is what used to
    // leave /json/list advertising pages from a dead Safari process while
    // every command vanished.
    rig.device.goSilent();

    await waitFor(async () => (await listTargets(rig.port)).length === 0, 4000);
    await waitFor(() => cdp.closeInfo !== null, 4000);
    expect(cdp.closeInfo!.reason).toContain("inspector connection lost");
  } finally {
    rig.stop();
  }
});

test("a fresh device is re-attached after the tunnel dies", async () => {
  const device = new FakeWirDevice();
  let current = device;
  let generation = 0;
  const rig = await startRig({}, {
    discoverSources: async (live) => {
      if (live.has(current.asSource().id)) return [];
      return [current.asSource()];
    },
  });
  try {
    await waitFor(async () => (await listTargets(rig.port)).length > 0);
    current.disconnect(new Error("usb tunnel reset"));
    await waitFor(async () => (await listTargets(rig.port)).length === 0);

    // usbmuxd re-enumerates; discovery hands back a new connection.
    current = new FakeWirDevice();
    generation++;
    await waitFor(async () => (await listTargets(rig.port)).length > 0, 5000);
    expect(generation).toBe(1);
    const targets = await listTargets(rig.port);
    expect(targets[0].url).toBe(PAGE_URL);
  } finally {
    rig.stop();
  }
});

test("Playwright's browser-level handshake is answered without dropping the socket", async () => {
  const rig = await startRig();
  try {
    await waitFor(async () => (await listTargets(rig.port)).length > 0);
    const version = (await (
      await fetch(`http://127.0.0.1:${rig.port}/json/version/`)
    ).json()) as any;
    const cdp = await RawCdp.open(version.webSocketDebuggerUrl);

    expect((await cdp.send("Browser.getVersion")).result.protocolVersion).toBe("1.3");
    expect(
      (await cdp.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      })).error,
    ).toBeUndefined();
    // Playwright treats a protocol error here as fatal.
    const download = await cdp.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: "/tmp/pw",
      eventsEnabled: true,
    });
    expect(download.error).toBeUndefined();

    const info = await cdp.send("Target.getTargetInfo");
    expect(info.error).toBeUndefined();
    expect(info.result.targetInfo.type).toBe("browser");

    // Auto-attach must cover the page and skip the service worker.
    const attached = cdp.events.filter((e) => e.method === "Target.attachedToTarget");
    expect(attached).toHaveLength(1);
    expect(attached[0].params.targetInfo.type).toBe("page");

    // An unimplemented browser method is an explicit error, never silence.
    const created = await cdp.send("Target.createTarget", { url: "about:blank" });
    expect(created.error.code).toBe(-32601);

    expect(cdp.open).toBe(true);
    cdp.close();
  } finally {
    rig.stop();
  }
});

test("flatten-mode page commands route through the browser socket", async () => {
  const rig = await startRig();
  try {
    await waitFor(async () => (await listTargets(rig.port)).length > 0);
    const version = (await (
      await fetch(`http://127.0.0.1:${rig.port}/json/version/`)
    ).json()) as any;
    const cdp = await RawCdp.open(version.webSocketDebuggerUrl);
    await cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await waitFor(() => cdp.events.some((e) => e.method === "Target.attachedToTarget"));
    const sessionId = cdp.events.find((e) => e.method === "Target.attachedToTarget")!.params
      .sessionId;
    const evaluated = await cdp.send(
      "Runtime.evaluate",
      { expression: "document.title" },
      { sessionId },
    );
    expect(evaluated.sessionId).toBe(sessionId);
    expect(evaluated.result.result.value).toBe("Puppet lab");
    cdp.close();
  } finally {
    rig.stop();
  }
});

// Puppeteer is a dev-only dependency of this package and is not vendored in
// the .deb build, so the real-client test runs only where it resolves.
async function loadPuppeteer(): Promise<any | null> {
  for (const spec of ["puppeteer-core", "puppeteer"]) {
    try {
      const mod = await import(spec);
      return mod.default ?? mod;
    } catch {}
  }
  return null;
}

test("puppeteer connect/pages/evaluate/goto against a fake WIR target", async () => {
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) {
    // Nothing to assert without the client; the scripted handshake tests
    // above still cover the protocol surface Puppeteer drives.
    return;
  }
  const rig = await startRig();
  try {
    await waitFor(async () => (await listTargets(rig.port)).length > 0);
    // Deliberately NOT passing defaultViewport:null — the default viewport
    // path sends Emulation.setTouchEmulationEnabled, which used to fail.
    const browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${rig.port}`,
      protocolTimeout: 10_000,
    });
    try {
      const pages = await browser.pages();
      expect(pages.length).toBe(1);
      expect(pages[0].url()).toBe(PAGE_URL);
      expect(await pages[0].evaluate(() => document.title)).toBe("Puppet lab");

      // page.goto drives Page.navigate plus the lifecycle events Puppeteer
      // waits on before it resolves.
      await pages[0].goto("https://example.test/puppet?mode=audio", {
        waitUntil: "domcontentloaded",
        timeout: 10_000,
      });
      expect(await pages[0].evaluate(() => location.href)).toBe(
        "https://example.test/puppet?mode=audio",
      );
    } finally {
      await browser.disconnect();
    }
  } finally {
    rig.stop();
  }
}, 30_000);
