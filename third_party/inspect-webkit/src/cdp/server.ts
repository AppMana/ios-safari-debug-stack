// Chrome DevTools Protocol bridge.
//
// HTTP endpoints expected by `chrome://inspect` and the chrome-devtools
// frontend & VS Code's pwa-chrome attach mode:
//   GET /json/version          — browser version blob
//   GET /json/list (= /json)   — list of debuggable targets
//   GET /                      — discovery aid
//
// WebSocket endpoint (one per debugging session):
//   ws://host:port/devtools/page/<targetId>
//
// targetId is "device:<udid>:<appId>:<pageId>" or "sim:<pid>:<appId>:<pageId>".
//
// Architecture:
//   For each connected source (USB device or simulator) we keep a single
//   WebInspectorClient ("backend") open for the server's lifetime. We
//   periodically refresh its target listing. When a DevTools client opens
//   a WS, we allocate a fresh WIRSenderKey, send forwardSocketSetup, and
//   route _rpc_applicationSentData: frames whose WIRDestinationKey matches
//   to that session's Target.

import { WebSocketServer, type WebSocket as WSWebSocket } from "ws";
import * as usbmux from "../usbmux";
import { LockdownClient } from "../lockdown";
import { WebInspectorClient, type WIMessage } from "../webinspector";
import * as sim from "../sim";
import { Target as CdpTarget, DEFAULT_COMMAND_TIMEOUT_MS } from "./target";
import { installIOSFilters } from "./ios-protocol";
import {
  type CdpServerBaseOptions,
  buildJsonTarget,
  createCdpHttpServer,
  listen,
  logCdpServerBanner,
} from "./http";
import { attachBrowserWs, type PageSessionHandle } from "./browser-endpoint";

export type Source = {
  kind: "device" | "simulator";
  id: string; // udid for device, "sim:<pid>" for simulator
  label: string;
  wi: WebInspectorClient;
  lockdown?: LockdownClient;
};

/**
 * Opens the sources the bridge should be talking to.
 *
 * Called once at startup and again on every reconnect tick with the ids
 * that are already live, so a healthy device is never re-opened (which
 * would drop its inspector sessions). Injectable so tests can drive the
 * server against an in-process fake Web Inspector.
 */
export type SourceDiscovery = (liveIds: ReadonlySet<string>) => Promise<Source[]>;

type CdpTargetEntry = {
  targetId: string;
  source: Source;
  appId: string;
  appName: string;
  bundleId?: string;
  pageId: number;
  title: string;
  url: string;
  type: string;
  /**
   * True when WIR reports a debugger connection on this page from a sender
   * we don't own. Safari greys out such entries in its Develop menu — only
   * one inspector may attach to a WebKit page at a time.
   */
  inUseByOtherInspector: boolean;
};

const REFRESH_MS = 1500;
/**
 * How long a source may go without delivering a single frame before the
 * bridge declares its tunnel dead.
 *
 * The USB tunnel to webinspectord can die half-open: no FIN, no RST, no
 * error — the socket simply stops carrying traffic (observed after Safari
 * was killed and relaunched on the device while usbmuxd re-enumerated).
 * The listing cache then freezes, /json/list keeps advertising pages from
 * a Safari process that no longer exists, and every command sent to those
 * targets is silently dropped. Every refresh tick sends
 * _rpc_getConnectedApplications:, which webinspectord always answers with
 * _rpc_reportConnectedApplicationList:, so silence for this long is proof
 * the tunnel is gone rather than merely idle.
 */
const SOURCE_STALE_MS = 12_000;
/** How often to look for devices/simulators that are not currently attached. */
const RECONNECT_MS = 3_000;

export type CdpServerOptions = CdpServerBaseOptions & {
  /**
   * Include Safari extension/background and worker targets that many CDP
   * clients cannot attach to. Off by default: only `page` targets are
   * listed and auto-attached.
   */
  includeExtensionTargets?: boolean;
  /** Override source discovery (tests drive an in-process fake device). */
  discoverSources?: SourceDiscovery;
  /** Per-command answer deadline before an explicit protocol error (ms). */
  commandTimeoutMs?: number;
  /** Listing/heartbeat poll interval (ms). */
  refreshMs?: number;
  /** Silence after which a source's tunnel is declared dead (ms). */
  sourceStaleMs?: number;
  /** Interval between attempts to attach devices that are not live (ms). */
  reconnectMs?: number;
};

export type CdpServer = {
  stop(): void;
  /** Snapshot of current debuggable targets. */
  getTargets(): CdpTargetEntry[];
  /**
   * Flash an inspectable target on the device — the way Safari does when you
   * hover an entry under Develop → device menu. Pass `on=true` to overlay
   * the page, `on=false` to clear. Safe to call repeatedly.
   */
  highlightTarget(targetId: string, on: boolean): Promise<void>;
  /**
   * Drop the cached hover-highlight session for a target (or all of them
   * when `targetId` is omitted). Hosts should call this when their picker
   * closes so we don't keep a WIR connection alive that would block other
   * debuggers from attaching.
   */
  releaseHighlight(targetId?: string): void;
};

export async function startCdpServer(opts: CdpServerOptions = {}): Promise<CdpServer> {
  const port = opts.port ?? 9222;
  const host = opts.host ?? "localhost";
  const includeExtensionTargets = opts.includeExtensionTargets ?? false;
  const commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const refreshMs = opts.refreshMs ?? REFRESH_MS;
  const sourceStaleMs = opts.sourceStaleMs ?? SOURCE_STALE_MS;
  const reconnectMs = opts.reconnectMs ?? RECONNECT_MS;

  const discoverSources = opts.discoverSources ?? defaultSourceDiscovery;

  // listing cache: continuously refreshed from each source's WI client.
  const listingsByApp = new Map<string, Map<string, any>>();
  // Track sources that have requested per-app listing notifications already.
  const subscribedAppsBySource = new WeakMap<Source, Set<string>>();
  let appsBySource = new Map<Source, any[]>();
  let sources: Source[] = [];

  type HighlightSession = {
    cdp: CdpTarget;
    source: Source;
    close: () => void;
    rootNodeIdPromise: Promise<number>;
    idleTimer: ReturnType<typeof setTimeout> | null;
  };
  const highlightSessions = new Map<string, HighlightSession>();
  const HIGHLIGHT_IDLE_MS = 8_000;

  function installSource(src: Source) {
    sources.push(src);
    appsBySource.set(src, []);
    subscribedAppsBySource.set(src, new Set());

    src.wi.subscribe((m) => {
      const sel = m.__selector as string | undefined;
      const arg = m.__argument as Record<string, any> | undefined;
      if (!sel || !arg) return;

      if (sel === "_rpc_reportConnectedApplicationList:") {
        const dict = (arg.WIRApplicationDictionaryKey as Record<string, any>) ?? {};
        const apps = Object.entries(dict).map(([appId, a]) => ({
          appId,
          bundleId: a.WIRApplicationBundleIdentifierKey,
          name: a.WIRApplicationNameKey ?? a.WIRApplicationBundleIdentifierKey ?? appId,
          isProxy: Boolean(a.WIRIsApplicationProxyKey),
        }));
        appsBySource.set(src, apps);
        const subs = subscribedAppsBySource.get(src)!;
        for (const a of apps) {
          if (a.isProxy || subs.has(a.appId)) continue;
          subs.add(a.appId);
          src.wi.send("_rpc_forwardGetListing:", { WIRApplicationIdentifierKey: a.appId });
        }
      } else if (sel === "_rpc_applicationConnected:") {
        const a = arg;
        const apps = appsBySource.get(src) ?? [];
        if (!apps.find((x) => x.appId === a.WIRApplicationIdentifierKey)) {
          apps.push({
            appId: a.WIRApplicationIdentifierKey,
            bundleId: a.WIRApplicationBundleIdentifierKey,
            name: a.WIRApplicationNameKey ?? a.WIRApplicationBundleIdentifierKey,
            isProxy: Boolean(a.WIRIsApplicationProxyKey),
          });
          appsBySource.set(src, apps);
        }
        if (!a.WIRIsApplicationProxyKey) {
          const subs = subscribedAppsBySource.get(src)!;
          if (!subs.has(a.WIRApplicationIdentifierKey)) {
            subs.add(a.WIRApplicationIdentifierKey);
            src.wi.send("_rpc_forwardGetListing:", {
              WIRApplicationIdentifierKey: a.WIRApplicationIdentifierKey,
            });
          }
        }
      } else if (sel === "_rpc_applicationDisconnected:") {
        const apps = appsBySource.get(src) ?? [];
        appsBySource.set(
          src,
          apps.filter((x) => x.appId !== arg.WIRApplicationIdentifierKey),
        );
        listingsByApp.delete(`${src.id}:${arg.WIRApplicationIdentifierKey}`);
      } else if (sel === "_rpc_applicationSentListing:") {
        const appId = arg.WIRApplicationIdentifierKey as string;
        const listing = (arg.WIRListingKey as Record<string, any>) ?? {};
        const map = new Map<string, any>();
        for (const [k, p] of Object.entries(listing)) {
          map.set(k, {
            pageId: Number(p.WIRPageIdentifierKey ?? 0),
            title: p.WIRTitleKey ?? "",
            url: p.WIRURLKey ?? "",
            type: p.WIRTypeKey ?? "",
            // WIR sets WIRConnectionIdentifierKey on a page once any inspector
            // (Safari Develop menu, chrome://inspect, our own bridge, ...)
            // attaches. Empty/missing → no debugger attached.
            connectionId: typeof p.WIRConnectionIdentifierKey === "string"
              ? p.WIRConnectionIdentifierKey
              : null,
          });
        }
        listingsByApp.set(`${src.id}:${appId}`, map);
      }
    });

    // Clean transport loss (FIN/RST/TLS error) — drop the source at once
    // instead of waiting for the staleness watchdog.
    src.wi.onClose((err) =>
      dropSource(src, `web inspector transport closed${err ? `: ${err.message}` : ""}`),
    );

    try {
      src.wi.send("_rpc_reportIdentifier:", {});
      src.wi.send("_rpc_getConnectedApplications:", {});
    } catch (e) {
      dropSource(src, `web inspector handshake failed: ${(e as Error).message}`);
      return;
    }
    console.error(`# source attached: ${src.label}`);
  }

  /**
   * Forget a source whose tunnel is gone.
   *
   * Everything derived from it has to go with it, or the bridge keeps
   * serving a frozen snapshot: the cached listings become targets that no
   * longer exist, and every CDP session bound to them accepts commands
   * that can never be delivered. Sessions are disposed with an explicit
   * reason so their clients see a protocol error instead of a hang.
   */
  function dropSource(src: Source, reason: string) {
    if (!sources.includes(src)) return;
    sources = sources.filter((s) => s !== src);
    appsBySource.delete(src);
    for (const key of [...listingsByApp.keys()]) {
      if (key.startsWith(`${src.id}:`)) listingsByApp.delete(key);
    }
    const detail = `${src.label}: ${reason}`;
    for (const [, rec] of [...sessions]) {
      if (rec.source === src) rec.close(`inspector connection lost — ${detail}`);
    }
    for (const [, sess] of [...highlightSessions]) {
      if (sess.source === src) sess.close();
    }
    try {
      src.wi.close();
    } catch {}
    try {
      src.lockdown?.close();
    } catch {}
    console.error(`# source lost: ${detail}`);
  }

  const refreshTimer = setInterval(() => {
    for (const src of [...sources]) {
      if (src.wi.closed) {
        dropSource(src, "web inspector transport closed");
        continue;
      }
      const silentMs = Date.now() - src.wi.lastMessageAt;
      if (silentMs > sourceStaleMs) {
        dropSource(src, `no response for ${silentMs}ms (tunnel is dead)`);
        continue;
      }
      try {
        // Liveness probe: webinspectord always answers this, even when the
        // device has no inspectable applications at all. That makes it a
        // reliable heartbeat, unlike the per-app listing polls below.
        src.wi.send("_rpc_getConnectedApplications:", {});
        const apps = appsBySource.get(src) ?? [];
        for (const a of apps) {
          if (a.isProxy) continue;
          src.wi.send("_rpc_forwardGetListing:", { WIRApplicationIdentifierKey: a.appId });
        }
      } catch (e) {
        dropSource(src, `write failed: ${(e as Error).message}`);
      }
    }
  }, refreshMs);

  type SessionRecord = {
    cdp: CdpTarget;
    source: Source;
    close: (reason?: string) => void;
  };
  const sessions = new Map<string, SessionRecord>(); // senderKey -> session

  // Re-attach devices and simulators that are not currently live. Covers
  // both a source that was dropped above and one that was never reachable
  // at startup (phone locked, Web Inspector off, cable plugged in later).
  let reconnecting = false;
  const reconnectWarned = new Set<string>();
  async function reconnectSources(): Promise<void> {
    if (reconnecting) return;
    reconnecting = true;
    try {
      const live = new Set(sources.map((s) => s.id));
      const found = await discoverSources(live);
      for (const src of found) {
        if (sources.some((s) => s.id === src.id)) {
          try {
            src.wi.close();
            src.lockdown?.close();
          } catch {}
          continue;
        }
        reconnectWarned.delete(src.id);
        installSource(src);
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (!reconnectWarned.has(msg)) {
        reconnectWarned.add(msg);
        console.error(`warn: source discovery: ${msg}`);
      }
    } finally {
      reconnecting = false;
    }
  }

  await reconnectSources();
  if (sources.length === 0) {
    console.error("warn: no inspectable sources found (no devices, no simulators).");
    console.error("      The server will still run; new targets will appear if you start one.");
  }
  const reconnectTimer = setInterval(() => void reconnectSources(), reconnectMs);

  function listTargets(): CdpTargetEntry[] {
    const out: CdpTargetEntry[] = [];
    for (const src of sources) {
      const apps = appsBySource.get(src) ?? [];
      for (const a of apps) {
        if (a.isProxy) continue;
        const listing = listingsByApp.get(`${src.id}:${a.appId}`);
        if (!listing) continue;
        for (const p of listing.values()) {
          if (!includeExtensionTargets && isHiddenTarget(p.url, p.type)) continue;
          // WIR allows only one debugger per page. WIRConnectionIdentifierKey
          // on a page is the *host* connection id (one per WebInspectorClient),
          // not our per-WS senderKey — so we compare against this source's
          // own connection id. A match means it's our own attachment (the
          // iframe inspector or a hover-highlight session); anything else is
          // a foreign debugger (Safari Develop menu, chrome://inspect, …).
          const otherInspector =
            !!p.connectionId && p.connectionId !== src.wi.connection;
          out.push({
            targetId: `${src.id}:${a.appId}:${p.pageId}`,
            source: src,
            appId: a.appId,
            appName: a.name,
            bundleId: a.bundleId,
            pageId: p.pageId,
            title: p.title,
            url: p.url,
            type: p.type,
            inUseByOtherInspector: otherInspector,
          });
        }
      }
    }
    return out;
  }

  const browserId = crypto.randomUUID();

  const httpServer = createCdpHttpServer({
    brand: "",
    version: (reqHost) => ({
      Browser: "Safari/inspect-webkit",
      "Protocol-Version": "1.3",
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS like Mac OS X) AppleWebKit/605.1.15 Safari/inspect-webkit",
      "WebKit-Version": "605.1.15",
      // Required by modern vscode-js-debug (pwa-chrome attach): it follows
      // this URL and expects browser-scope Target.* multiplexing. Served by
      // attachBrowserWs below.
      webSocketDebuggerUrl: `ws://${reqHost}/devtools/browser/${browserId}`,
    }),
    listTargets: (reqHost) =>
      listTargets().map((t) =>
        buildJsonTarget({
          reqHost,
          id: t.targetId,
          description: `${t.source.label}${t.bundleId ? ` (${t.bundleId})` : ""}`,
          title: t.title || t.appName,
          // chrome://inspect silently drops targets whose `url` isn't http(s) —
          // Safari reports `file:///…/Foo.app/` for native WKWebViews, which
          // would hide the entire group. Substitute about:blank so the row
          // still renders. The real bundle path stays in `description`.
          url: /^https?:/i.test(t.url) ? t.url : "about:blank",
          type: mapWIRType(t.type),
        }),
      ),
  });

  const wss = new WebSocketServer({ noServer: true });
  const browserPath = `/devtools/browser/${browserId}`;

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    console.error(`# ws upgrade: ${url.pathname}`);
    if (url.pathname === browserPath) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachBrowserWs(ws, {
          listEntries: () =>
            listTargets().map((t) => ({
              targetId: t.targetId,
              type: mapWIRType(t.type),
              title: t.title || t.appName,
              url: t.url,
            })),
          createPageSession: (targetId, send) => {
            const entry = listTargets().find((t) => t.targetId === targetId);
            if (!entry) return null;
            return createPageSession(entry, send);
          },
        });
      });
      return;
    }
    if (!url.pathname.startsWith("/devtools/page/")) {
      console.error(`# ws upgrade rejected: unknown path ${url.pathname}`);
      socket.destroy();
      return;
    }
    const targetId = decodeURIComponent(url.pathname.slice("/devtools/page/".length));
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachWs(ws, targetId);
    });
  });

  function createPageSession(
    entry: CdpTargetEntry,
    sendToTools: (text: string) => void,
    onServerClose?: (reason: string) => void,
  ): PageSessionHandle | null {
    const senderKey = crypto.randomUUID();
    // Virtual ws — CdpTarget only uses readyState + send().
    const fakeWs = {
      readyState: 1,
      send: (text: string) => sendToTools(text),
    } as unknown as WSWebSocket;
    const cdp = new CdpTarget(fakeWs, entry.source.wi, entry.appId, entry.pageId, senderKey, {
      commandTimeoutMs,
    });
    installIOSFilters(cdp);

    const debug = !!process.env.INSPECT_WEBKIT_DEBUG;
    const unsub = entry.source.wi.subscribe((m: WIMessage) => {
      if (m.__selector !== "_rpc_applicationSentData:") return;
      const arg = m.__argument as Record<string, any> | undefined;
      if (!arg) return;
      if (arg.WIRDestinationKey && arg.WIRDestinationKey !== senderKey) return;
      if (arg.WIRApplicationIdentifierKey !== entry.appId) return;
      if (
        arg.WIRPageIdentifierKey !== undefined &&
        Number(arg.WIRPageIdentifierKey) !== entry.pageId
      )
        return;
      const data = arg.WIRMessageDataKey ?? arg.WIRSocketDataKey;
      if (!data) return;
      const text =
        typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array);
      if (debug) console.error(`[cdp] target>> ${text.slice(0, 240)}`);
      cdp.onMessageFromTarget(text);
    });

    const close = (reason?: string) => {
      if (!sessions.delete(senderKey)) return;
      unsub();
      // Explicitly answer anything still in flight before the session goes
      // away, so the client never waits on a command that can no longer be
      // delivered.
      if (reason) cdp.dispose(reason);
      try {
        cdp.wi.forwardDidClose(cdp.appId, cdp.pageId, cdp.senderKey);
      } catch {
        // The tunnel is already gone; nothing to release on the device.
      }
      if (reason) onServerClose?.(reason);
    };
    sessions.set(senderKey, { cdp, source: entry.source, close });

    try {
      entry.source.wi.forwardSocketSetup(entry.appId, entry.pageId, senderKey);
    } catch (e) {
      close(`could not attach to ${entry.targetId}: ${(e as Error).message}`);
      return null;
    }
    console.error(
      `# devtools attached: ${entry.source.label} :: ${entry.appName} :: ${entry.title || entry.url}`,
    );

    return {
      onMessageFromTools(text: string) {
        if (debug) console.error(`[cdp] tools>>  ${text.slice(0, 300)}`);
        cdp.onMessageFromTools(text);
      },
      close() {
        close();
      },
    };
  }

  // Hover-highlight sessions. Each target keeps its own short-lived CDP
  // session so the host UI can flash an inspectable target the way Safari
  // does when you hover an entry under Develop → device menu. We cache the
  // session per target (DOM.getDocument is non-trivial), and idle-close it
  // after 30s of no highlight activity.

  function getOrOpenHighlightSession(targetId: string): HighlightSession | null {
    const existing = highlightSessions.get(targetId);
    if (existing) return existing;
    const entry = listTargets().find((t) => t.targetId === targetId);
    if (!entry) return null;
    const senderKey = crypto.randomUUID();
    const fakeWs = { readyState: 1, send: () => {} } as unknown as WSWebSocket;
    const cdp = new CdpTarget(fakeWs, entry.source.wi, entry.appId, entry.pageId, senderKey, {
      commandTimeoutMs,
    });
    installIOSFilters(cdp);
    const unsub = entry.source.wi.subscribe((m: WIMessage) => {
      if (m.__selector !== "_rpc_applicationSentData:") return;
      const arg = m.__argument as Record<string, any> | undefined;
      if (!arg) return;
      if (arg.WIRDestinationKey && arg.WIRDestinationKey !== senderKey) return;
      if (arg.WIRApplicationIdentifierKey !== entry.appId) return;
      if (
        arg.WIRPageIdentifierKey !== undefined &&
        Number(arg.WIRPageIdentifierKey) !== entry.pageId
      )
        return;
      const data = arg.WIRMessageDataKey ?? arg.WIRSocketDataKey;
      if (!data) return;
      const text =
        typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array);
      cdp.onMessageFromTarget(text);
    });
    sessions.set(senderKey, {
      cdp,
      source: entry.source,
      close: () => highlightSessions.get(targetId)?.close(),
    });
    try {
      entry.source.wi.forwardSocketSetup(entry.appId, entry.pageId, senderKey);
    } catch {
      sessions.delete(senderKey);
      return null;
    }
    // DOM.getDocument can stall if Safari hasn't dispatched Target.targetCreated
    // yet — wrap in 5s so callers don't hang. We close the session below in
    // the .catch on the cached promise.
    const rootNodeIdPromise: Promise<number> = Promise.race([
      cdp.callTarget("DOM.getDocument", { depth: 0 }).then((r: any) => r?.root?.nodeId as number),
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error("DOM.getDocument timeout")), 5_000),
      ),
    ]);
    const session: HighlightSession = {
      cdp,
      source: entry.source,
      rootNodeIdPromise,
      idleTimer: null,
      close() {
        if (session.idleTimer) clearTimeout(session.idleTimer);
        unsub();
        cdp.dispose("highlight session closed");
        try {
          cdp.wi.forwardDidClose(cdp.appId, cdp.pageId, cdp.senderKey);
        } catch {}
        sessions.delete(senderKey);
        highlightSessions.delete(targetId);
      },
    };
    highlightSessions.set(targetId, session);
    rootNodeIdPromise.catch(() => session.close());
    return session;
  }

  function bumpHighlightIdle(session: HighlightSession) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => session.close(), HIGHLIGHT_IDLE_MS);
  }

  function releaseHighlight(targetId?: string): void {
    if (targetId) {
      highlightSessions.get(targetId)?.close();
      return;
    }
    for (const sess of highlightSessions.values()) sess.close();
  }

  async function highlightTarget(targetId: string, on: boolean): Promise<void> {
    const session = getOrOpenHighlightSession(targetId);
    if (!session) return;
    bumpHighlightIdle(session);
    try {
      if (on) {
        const nodeId = await session.rootNodeIdPromise;
        if (!nodeId) return;
        await session.cdp.callTarget("DOM.highlightNode", {
          nodeId,
          highlightConfig: {
            showInfo: false,
            contentColor: { r: 111, g: 168, b: 220, a: 0.55 },
            paddingColor: { r: 147, g: 196, b: 125, a: 0 },
            borderColor: { r: 255, g: 229, b: 153, a: 0 },
            marginColor: { r: 246, g: 178, b: 107, a: 0 },
          },
        });
      } else {
        await session.cdp.callTarget("DOM.hideHighlight", {});
      }
    } catch {
      // Stale target — drop the session so the next call reopens.
      session.close();
    }
  }

  function attachWs(ws: WSWebSocket, targetId: string) {
    const entry = listTargets().find((t) => t.targetId === targetId);
    if (!entry) {
      console.error(
        `# ws closed: unknown target ${targetId} (known: ${listTargets()
          .map((t) => t.targetId)
          .join(", ") || "none"})`,
      );
      ws.close(1011, `unknown target ${targetId}`);
      return;
    }
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const sess = createPageSession(
      entry,
      (text) => {
        if (ws.readyState === 1) ws.send(text);
      },
      // The session was torn down by the server (the device's tunnel died,
      // the page went away). Close the socket with a reason instead of
      // leaving the client talking into a session that is gone.
      (reason) => {
        if (heartbeat) clearInterval(heartbeat);
        try {
          ws.close(1011, reason.slice(0, 120));
        } catch {}
      },
    );
    if (!sess) {
      ws.close(1011, `could not attach to ${targetId}`);
      return;
    }
    // Liveness probe: if the peer disappears (browser tab killed, network
    // glitch) the OS may not surface a TCP RST for minutes. Without this,
    // the orphaned session would keep the WIR slot occupied and block other
    // debuggers from attaching. Ping every 15s; tear down after one miss.
    let alive = true;
    ws.on("pong", () => { alive = true; });
    heartbeat = setInterval(() => {
      if (!alive) {
        try { ws.terminate(); } catch {}
        return;
      }
      alive = false;
      try { ws.ping(); } catch {}
    }, 15_000);
    ws.on("message", (raw, isBinary) => {
      const text = isBinary ? new TextDecoder().decode(raw as Buffer) : raw.toString();
      sess.onMessageFromTools(text);
    });
    ws.on("close", () => {
      if (heartbeat) clearInterval(heartbeat);
      sess.close();
    });
  }

  await listen(httpServer, host, port);
  logCdpServerBanner({ brand: "safari", host, port });

  return {
    stop() {
      clearInterval(refreshTimer);
      clearInterval(reconnectTimer);
      for (const sess of [...highlightSessions.values()]) sess.close();
      for (const [, rec] of [...sessions]) rec.close("bridge shutting down");
      wss.close();
      httpServer.close();
      for (const src of sources) {
        try {
          src.wi.close();
          src.lockdown?.close();
        } catch {}
      }
      sources = [];
    },
    /** Snapshot of current debuggable targets. */
    getTargets(): CdpTargetEntry[] {
      return listTargets();
    },
    /**
     * Flash an inspectable target on the device — the way Safari does when
     * you hover an entry under Develop → device menu. `on=true` overlays the
     * page; `on=false` clears it. Sessions are cached per-target and idle-
     * closed after a short grace period.
     */
    highlightTarget(targetId: string, on: boolean): Promise<void> {
      return highlightTarget(targetId, on);
    },
    releaseHighlight(targetId?: string): void {
      releaseHighlight(targetId);
    },
  };
}

/**
 * Default discovery: every USB device and simulator that is not already
 * attached. Failures are reported once per device until that device is
 * opened successfully, so a locked phone doesn't spam the log every few
 * seconds while the reconnect loop keeps trying.
 */
const discoveryWarned = new Set<string>();

export const defaultSourceDiscovery: SourceDiscovery = async (liveIds) => {
  const [devices, simulators] = await Promise.all([
    openDeviceSources(liveIds),
    openSimulatorSources(liveIds),
  ]);
  return [...devices, ...simulators];
};

async function openDeviceSources(liveIds: ReadonlySet<string>): Promise<Source[]> {
  let devices: usbmux.Device[] = [];
  try {
    devices = await usbmux.listDevices();
  } catch (e) {
    warnOnce("usbmux", `usbmux: ${(e as Error).message}`);
    return [];
  }
  const pending = devices.filter((d) => !liveIds.has(`device:${d.Properties.SerialNumber}`));
  const sources = await Promise.all(pending.map(openDeviceSource));
  return sources.filter((s): s is Source => s !== null);
}

function warnOnce(key: string, message: string) {
  if (discoveryWarned.has(key)) return;
  discoveryWarned.add(key);
  console.error(`warn: ${message}`);
}

async function openDeviceSource(d: usbmux.Device): Promise<Source | null> {
  try {
    const pair = await usbmux.readPairRecord(d.Properties.SerialNumber);
    const lockdown = await LockdownClient.open(d, pair);
    await lockdown.startSession();
    const svc = await lockdown.startService("com.apple.webinspector");
    const { socket, stream } = await lockdown.connectService(svc);
    const wi = new WebInspectorClient(socket, stream);
    await wi.reportIdentifier();
    discoveryWarned.delete(`device:${d.Properties.SerialNumber}`);
    return {
      kind: "device",
      id: `device:${d.Properties.SerialNumber}`,
      label: `device:${d.Properties.SerialNumber.slice(0, 8)}`,
      wi,
      lockdown,
    };
  } catch (e) {
    warnOnce(
      `device:${d.Properties.SerialNumber}`,
      `device ${d.Properties.SerialNumber}: ${(e as Error).message}`,
    );
    return null;
  }
}

async function openSimulatorSources(liveIds: ReadonlySet<string>): Promise<Source[]> {
  let runtimes: sim.SimRuntime[] = [];
  try {
    runtimes = await sim.findSimulatorSockets();
  } catch (e) {
    warnOnce("sim-discovery", `simulator discovery: ${(e as Error).message}`);
    return [];
  }
  const pending = runtimes.filter((r) => !liveIds.has(`sim:${r.pid}`));
  const sources = await Promise.all(pending.map(openSimulatorSource));
  return sources.filter((s): s is Source => s !== null);
}

async function openSimulatorSource(r: sim.SimRuntime): Promise<Source | null> {
  try {
    const { socket, stream } = await sim.connectSimulator(r.socketPath);
    const wi = new WebInspectorClient(socket, stream);
    await wi.reportIdentifier();
    discoveryWarned.delete(`sim:${r.pid}`);
    return {
      kind: "simulator",
      id: `sim:${r.pid}`,
      label: `sim:${r.pid}`,
      wi,
    };
  } catch (e) {
    warnOnce(`sim:${r.pid}`, `simulator ${r.socketPath}: ${(e as Error).message}`);
    return null;
  }
}

// Map Safari's WIRTypeKey onto a CDP target type.
//
// chrome://inspect, Puppeteer and Playwright all filter on type === "page",
// so the mapping has to be exact rather than optimistic. iOS 27 reports
// "WIRTypeWebPage" for ordinary Safari tabs and "WIRTypeServiceWorker" for
// service workers (verified live). Older iOS builds leave WIRTypeKey unset
// for tabs, which arrives here as "".
//
// Anything unrecognised becomes "other" — never "page". Claiming an unknown
// Safari internal target is an ordinary web page is what let service-worker
// and extension targets reach Puppeteer's auto-attach, where the page-shaped
// boot sequence (Page.enable, Network.enable, Emulation.*) never completes.
const UNKNOWN_WIR_TYPES = new Set<string>();

export function mapWIRType(t: string): string {
  switch (t) {
    case "WIRTypeServiceWorker":
      return "service_worker";
    case "WIRTypeWorker":
    case "WIRTypeJavaScript":
      return "worker";
    case "":
    case "WIRTypeWeb":
    case "WIRTypePage":
    case "WIRTypeWebPage":
      return "page";
    default:
      if (!UNKNOWN_WIR_TYPES.has(t)) {
        UNKNOWN_WIR_TYPES.add(t);
        console.error(`# unknown WIRTypeKey ${JSON.stringify(t)} — reported as type "other"`);
      }
      return "other";
  }
}

/**
 * Targets hidden from /json/list and from browser-level discovery unless
 * `includeExtensionTargets` is set: Safari extension/background pages and
 * every non-page target (service workers, dedicated workers, internals).
 * They accept a WIR inspector connection but do not answer the page-shaped
 * domains CDP clients drive immediately after attaching, and each one
 * consumes the single inspector slot WebKit grants per target.
 */
export function isHiddenTarget(url: string, wirType: string): boolean {
  if (/^safari-web-extension:/i.test(url)) return true;
  return mapWIRType(wirType) !== "page";
}
