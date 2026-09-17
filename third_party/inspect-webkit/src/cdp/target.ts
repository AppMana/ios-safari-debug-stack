// One CDP "session" — bridges a single DevTools WebSocket to one Safari page
// via _rpc_forwardSocketSetup / _rpc_forwardSocketData.
//
// Symmetric filter pipeline: a `tools::<method>` filter inspects/rewrites
// outgoing requests from DevTools, a `target::<method>` filter inspects/
// rewrites incoming responses or events from Safari. Per-domain code in
// src/cdp/domains/*.ts hangs translations off these.
//
// Flow:
//   DevTools  --(JSON)-->  onMessageFromTools  --filters-->  sendToTarget
//                                                              |
//                                                              v
//                                          _rpc_forwardSocketData (WIR)
//                                                              |
//   DevTools  <--(JSON)--  filters  <-- onMessageFromTarget <--+
//
// Ids:
//   - tool requests use msg.id from the DevTools client (positive)
//   - adapter-internal callTarget() uses negative ids to disambiguate
//
// Filters return the (possibly rewritten) message, or null to swallow it.

import type { WebSocket as WSWebSocket } from "ws";
import type { WebInspectorClient } from "../webinspector";

export type CdpMessage = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
};

type Filter = (msg: CdpMessage) => Promise<CdpMessage | null>;

type Pending = {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Hard ceiling on how long a single CDP command may go unanswered before
 * the bridge replies with an explicit protocol error.
 *
 * A Safari page can stop answering for reasons the bridge cannot see: the
 * WIR session was invalidated by a navigation that swapped the web process,
 * another inspector grabbed the page's single allowed connection, or the
 * USB tunnel died half-open. Every one of those used to present as "the
 * command vanished", which is the worst possible failure mode for a client
 * like Puppeteer or Playwright: it blocks forever, or until the client's
 * own (much longer) protocol timeout fires with no useful diagnosis.
 *
 * A target must never silently drop a command.
 *
 * The ceiling is generous on purpose. A page running heavy work on its main
 * thread (an ML pipeline, a long synchronous task) genuinely cannot execute
 * an evaluate until it yields, and killing such a command would be wrong.
 * The watchdog exists to convert "never" into "eventually, with a reason" —
 * it still fires well inside Puppeteer's own 180s protocol timeout.
 * Override with INSPECT_WEBKIT_COMMAND_TIMEOUT_MS.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = resolveDefaultCommandTimeout();

function resolveDefaultCommandTimeout(): number {
  const raw = Number(process.env.INSPECT_WEBKIT_COMMAND_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

export type TargetOptions = {
  /** Override the per-command answer deadline (ms). */
  commandTimeoutMs?: number;
};

export class Target {
  private filters = new Map<string, Filter[]>();
  private toolRequestMap = new Map<number, string>();
  private adapterRequestMap = new Map<number, Pending>();
  // Adapter calls and Target.sendMessageToTarget envelopes need disjoint ids.
  // WebKit may deliver the inner response before the outer envelope ack; if
  // both share an id, the inner response is mistaken for the ack and dropped.
  private adapterRequestId = 1;
  private wrapperRequestId = 2;
  // Target-based mode (modern Safari, iOS 13+): each page exposes inner
  // CDP targets. We auto-detect on the first Target.targetCreated of type
  // "page" and from then on wrap outgoing non-Target.* messages in
  // Target.sendMessageToTarget, and unwrap incoming
  // Target.dispatchMessageFromTarget.
  private innerTargetId: string | null = null;
  private wrappedAckIds = new Set<number>();
  // Outgoing messages sent before we've discovered the inner target. They
  // can't be dispatched yet (Safari would respond with "domain not found"),
  // so we hold them until the first Target.targetCreated arrives.
  private outgoingQueue: string[] = [];
  private sawAnyTargetCreated = false;
  // Watchdog timers for tool requests that are still awaiting an answer.
  private toolRequestTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private commandTimeoutMs: number;
  private disposedReason: string | null = null;

  constructor(
    private ws: WSWebSocket,
    public readonly wi: WebInspectorClient,
    public readonly appId: string,
    public readonly pageId: number,
    public readonly senderKey: string,
    opts: TargetOptions = {},
  ) {
    this.commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  addMessageFilter(method: string, filter: Filter) {
    let list = this.filters.get(method);
    if (!list) this.filters.set(method, (list = []));
    list.push(filter);
  }

  /** Adapter-initiated call into Safari, awaitable. Uses a negative id. */
  callTarget(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.disposedReason) {
        reject(new Error(this.disposedReason));
        return;
      }
      const id = -this.adapterRequestId;
      this.adapterRequestId += 2;
      const timer = setTimeout(() => {
        this.adapterRequestMap.delete(id);
        reject(new Error(`${method} timed out after ${this.commandTimeoutMs}ms`));
      }, this.commandTimeoutMs);
      this.adapterRequestMap.set(id, { resolve, reject, timer });
      try {
        this.sendRaw(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.adapterRequestMap.delete(id);
        reject(e);
      }
    });
  }

  fireEventToTools(method: string, params: any) {
    this.sendToTools(JSON.stringify({ method, params }));
  }

  fireResultToTools(id: number, result: any) {
    this.clearToolRequest(id);
    this.sendToTools(JSON.stringify({ id, result }));
  }

  fireErrorToTools(id: number, error: { code?: number; message: string }) {
    this.clearToolRequest(id);
    this.sendToTools(
      JSON.stringify({ id, error: { code: error.code ?? -32000, message: error.message } }),
    );
  }

  replyEmpty(msg: CdpMessage): Promise<null> {
    if (typeof msg.id === "number") this.fireResultToTools(msg.id, {});
    return Promise.resolve(null);
  }

  /** Called by the server when the DevTools client sends a frame. */
  async onMessageFromTools(rawMessage: string) {
    let msg: CdpMessage;
    try {
      msg = JSON.parse(rawMessage);
    } catch {
      return;
    }
    if (typeof msg.method === "string" && typeof msg.id === "number") {
      if (this.disposedReason) {
        this.fireErrorToTools(msg.id, { code: -32000, message: this.disposedReason });
        return;
      }
      this.toolRequestMap.set(msg.id, msg.method);
      this.armToolTimeout(msg.id, msg.method);
    }
    const eventName = `tools::${msg.method}`;
    const list = this.filters.get(eventName);
    let outgoing: CdpMessage | null = msg;
    if (list) {
      for (const f of list) {
        if (!outgoing) break;
        outgoing = await f(outgoing);
      }
    }
    if (!outgoing) return;
    try {
      this.sendRaw(JSON.stringify(outgoing));
    } catch (e) {
      if (typeof msg.id === "number") {
        this.fireErrorToTools(msg.id, {
          code: -32000,
          message: `${msg.method ?? "command"} could not be delivered: ${(e as Error).message}`,
        });
      }
    }
  }

  /**
   * Arm the per-command watchdog. Fires an explicit protocol error back to
   * the client if Safari never answers, so a wedged or invalidated WIR
   * session surfaces as a failed command instead of a hang.
   */
  private armToolTimeout(id: number, method: string) {
    const existing = this.toolRequestTimers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.toolRequestTimers.delete(id);
      if (!this.toolRequestMap.delete(id)) return;
      this.sendToTools(
        JSON.stringify({
          id,
          error: {
            code: -32000,
            message:
              `${method} timed out after ${this.commandTimeoutMs}ms: the Safari page ` +
              `(app ${this.appId}, page ${this.pageId}) did not answer. The inspector ` +
              `session may have been invalidated by a navigation or claimed by another ` +
              `debugger; reattach to this target.`,
          },
        }),
      );
    }, this.commandTimeoutMs);
    // Node keeps the process alive for pending timers; a per-command
    // watchdog must not do that.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.toolRequestTimers.set(id, timer);
  }

  /** True while a tool request is still awaiting an answer (its watchdog
   *  has not fired and nothing has replied yet). Long-running translations
   *  check this before replying so a timed-out request is not answered
   *  twice. */
  hasPendingToolRequest(id: number): boolean {
    return this.toolRequestMap.has(id);
  }

  private clearToolRequest(id: number) {
    const timer = this.toolRequestTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.toolRequestTimers.delete(id);
    }
    this.toolRequestMap.delete(id);
  }

  /**
   * Tear the session down and make sure nothing is left waiting. Called
   * when the WIR transport behind this target dies, when the owning source
   * is replaced, or when the DevTools socket goes away.
   */
  dispose(reason: string) {
    if (this.disposedReason) return;
    this.disposedReason = reason;
    for (const [id, timer] of this.toolRequestTimers) {
      clearTimeout(timer);
      this.sendToTools(JSON.stringify({ id, error: { code: -32000, message: reason } }));
    }
    this.toolRequestTimers.clear();
    this.toolRequestMap.clear();
    for (const [, pending] of this.adapterRequestMap) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.adapterRequestMap.clear();
    this.outgoingQueue = [];
  }

  get disposed(): boolean {
    return this.disposedReason !== null;
  }

  /** Called by the WebInspector pump when a forward-socket frame arrives
   *  for THIS sender. */
  async onMessageFromTarget(rawMessage: string): Promise<void> {
    let msg: CdpMessage;
    try {
      msg = JSON.parse(rawMessage);
    } catch {
      return;
    }

    // Target-based mode: pick up the inner page targetId once, then
    // unwrap dispatched messages.
    if (msg.method === "Target.targetCreated") {
      this.sawAnyTargetCreated = true;
      const info = msg.params?.targetInfo;
      if (info?.type === "page" && !this.innerTargetId) {
        this.innerTargetId = info.targetId;
        this.flushQueue();
      }
      // Swallow Target.* events — DevTools doesn't expect them on the
      // top-level connection here.
      return;
    }
    if (msg.method === "Target.didCommitProvisionalTarget") {
      // Cross-origin navigation: WebKit swapped the active target. Re-pin
      // innerTargetId so subsequent wraps land on the live target instead
      // of the dead one.
      const newTargetId = msg.params?.newTargetId;
      if (typeof newTargetId === "string") this.innerTargetId = newTargetId;
      return;
    }
    if (msg.method === "Target.targetDestroyed") return;
    if (msg.method === "Target.dispatchMessageFromTarget") {
      const inner = msg.params?.message;
      if (typeof inner === "string") return this.onMessageFromTarget(inner);
      return;
    }

    if (typeof msg.id === "number" && this.wrappedAckIds.has(msg.id)) {
      // Drop the ack of a wrapped Target.sendMessageToTarget — the real
      // response arrives separately via Target.dispatchMessageFromTarget.
      // The outer ack carries `{result: {}}` regardless of the inner
      // command's actual result, so we MUST wait for the unwrap.
      this.wrappedAckIds.delete(msg.id);
      return;
    }

    if (typeof msg.id === "number") {
      const adapterPending = this.adapterRequestMap.get(msg.id);
      if (adapterPending) {
        this.adapterRequestMap.delete(msg.id);
        clearTimeout(adapterPending.timer);
        if ("error" in msg && msg.error) adapterPending.reject(msg.error);
        else adapterPending.resolve(msg.result ?? {});
        return;
      }

      const method = this.toolRequestMap.get(msg.id);
      if (method) {
        this.clearToolRequest(msg.id);
        let eventName = `target::${method}`;
        if ("error" in msg && this.filters.has("target::error")) eventName = "target::error";
        const list = this.filters.get(eventName);
        if (!list) return this.sendToTools(rawMessage);
        let m: CdpMessage | null = msg;
        for (const f of list) {
          if (!m) break;
          m = await f(m);
        }
        if (m) this.sendToTools(JSON.stringify(m));
        return;
      }
      // Unknown id; pass through.
      return this.sendToTools(rawMessage);
    }

    // Event from the target.
    const eventName = `target::${msg.method}`;
    const list = this.filters.get(eventName);
    if (!list) return this.sendToTools(rawMessage);
    let m: CdpMessage | null = msg;
    for (const f of list) {
      if (!m) break;
      m = await f(m);
    }
    if (m) this.sendToTools(JSON.stringify(m));
  }

  private sendRaw(rawMessage: string) {
    // Parse to inspect; if not JSON, pass straight through.
    let m: CdpMessage | null = null;
    try {
      m = JSON.parse(rawMessage);
    } catch {}

    const isTargetDomain =
      m && typeof m.method === "string" && m.method.startsWith("Target.");

    // If target-based mode is in effect, wrap.
    if (this.innerTargetId && m && !isTargetDomain) {
      const wrapperId = -this.wrapperRequestId;
      this.wrapperRequestId += 2;
      this.wrappedAckIds.add(wrapperId);
      const wrapped = {
        id: wrapperId,
        method: "Target.sendMessageToTarget",
        params: { id: m.id, message: rawMessage, targetId: this.innerTargetId },
      };
      this.writeFrame(JSON.stringify(wrapped));
      return;
    }

    // If we haven't yet learned the inner targetId but the inspector is
    // operating in target-based mode (we'll know once any targetCreated
    // arrives), buffer non-Target.* sends. Adapter calls (negative ids)
    // also buffer — they need the inner target too.
    if (!this.innerTargetId && m && !isTargetDomain) {
      this.outgoingQueue.push(rawMessage);
      // If we haven't seen ANY targetCreated within 250ms, assume the
      // inspector isn't running in target-based mode and flush straight
      // through. If targetCreated *did* arrive but we don't have a page
      // target yet, keep waiting — flushing raw would route adapter calls
      // (negative ids) to the outer target id:-1, where state changes like
      // Debugger.setBreakpointsActive get lost and breakpoint events never
      // fire on the inner page.
      if (this.outgoingQueue.length === 1) {
        setTimeout(() => {
          if (!this.innerTargetId && !this.sawAnyTargetCreated && this.outgoingQueue.length > 0) {
            const queued = this.outgoingQueue;
            this.outgoingQueue = [];
            for (const raw of queued) this.writeFrame(raw);
          }
        }, 250);
      }
      return;
    }

    this.writeFrame(rawMessage);
  }

  private flushQueue() {
    if (this.outgoingQueue.length === 0) return;
    const queued = this.outgoingQueue;
    this.outgoingQueue = [];
    for (const raw of queued) this.sendRaw(raw);
  }

  private writeFrame(payload: string) {
    this.wi.forwardSocketData(
      this.appId,
      this.pageId,
      this.senderKey,
      new TextEncoder().encode(payload),
    );
  }

  private sendToTools(rawMessage: string) {
    if (this.ws.readyState === 1) this.ws.send(rawMessage);
  }
}
