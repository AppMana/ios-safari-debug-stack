// An in-process fake of Safari's `com.apple.webinspector` service.
//
// It speaks the real wire format (uint32 BE length + plist) and the real
// selectors, so `startCdpServer()` can be driven end-to-end without a phone:
// discovery, per-page forward sockets, target-based message wrapping, and
// transport loss are all reproducible here.
//
// It models the two behaviours that made real devices hard to bridge:
//
//   1. Target-based mode. Modern WebKit answers a forwardSocketSetup with
//      `Target.targetCreated` and from then on expects every command wrapped
//      in `Target.sendMessageToTarget`, replying with an empty ack plus a
//      separate `Target.dispatchMessageFromTarget` carrying the real result.
//   2. Silent death. `goSilent()` makes the tunnel stop carrying traffic
//      without closing it — exactly what a half-open USB tunnel does after
//      the device's Safari process is replaced.

import { ByteStream } from "../../stream";
import { encodeXml, decode, type PlistValue } from "../../plist";
import { WebInspectorClient } from "../../webinspector";
import type { Source } from "../server";

export type FakePage = {
  pageId: number;
  title: string;
  url: string;
  /** Raw WIRTypeKey, e.g. "WIRTypeWebPage" or "WIRTypeServiceWorker". */
  wirType: string;
};

export type FakeDeviceOptions = {
  udid?: string;
  appId?: string;
  appName?: string;
  bundleId?: string;
  pages?: FakePage[];
  /**
   * Answer a CDP command from the fake page. Return `undefined` to fall
   * through to the built-in answers, or `null` to drop the command (used to
   * reproduce a wedged inspector session).
   */
  answer?: (method: string, params: any) => any | null | undefined;
};

type Frame = Record<string, PlistValue>;

/** Minimal net.Socket stand-in that feeds a ByteStream in both directions. */
class FakeSocket {
  private listeners = new Map<string, Set<(arg?: any) => void>>();
  private inbox: Uint8Array[] = [];
  private pending = 0;
  ended = false;

  constructor(private onFrame: (frame: Frame) => void) {}

  write(chunk: Uint8Array) {
    if (this.ended) return;
    this.inbox.push(chunk);
    this.pending += chunk.length;
    this.drain();
  }

  private drain() {
    // Frames arrive as a 4-byte length write followed by a body write.
    for (;;) {
      if (this.pending < 4) return;
      const joined = this.join();
      const len = new DataView(joined.buffer, joined.byteOffset, 4).getUint32(0, false);
      if (joined.length < 4 + len) return;
      const body = joined.subarray(4, 4 + len);
      const rest = joined.subarray(4 + len);
      this.inbox = rest.length > 0 ? [rest] : [];
      this.pending = rest.length;
      let frame: Frame | null = null;
      try {
        frame = decode(body) as Frame;
      } catch {
        frame = null;
      }
      if (frame) this.onFrame(frame);
    }
  }

  private join(): Uint8Array {
    if (this.inbox.length === 1) return this.inbox[0]!;
    const out = new Uint8Array(this.pending);
    let off = 0;
    for (const c of this.inbox) {
      out.set(c, off);
      off += c.length;
    }
    this.inbox = [out];
    return out;
  }

  on(event: string, fn: (arg?: any) => void) {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return this;
  }

  off(event: string, fn: (arg?: any) => void) {
    this.listeners.get(event)?.delete(fn);
    return this;
  }

  emit(event: string, arg?: any) {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(arg);
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.emit("close");
  }

  destroy() {
    this.end();
  }
}

export class FakeWirDevice {
  readonly udid: string;
  readonly appId: string;
  readonly appName: string;
  readonly bundleId: string;
  readonly wi: WebInspectorClient;

  private pages: FakePage[];
  private socket: FakeSocket;
  private stream = new ByteStream();
  private silent = false;
  /** senderKey -> inner target id handed out on forwardSocketSetup. */
  private senders = new Map<string, string>();
  private nextInnerTarget = 1;
  private loaderSeq = 2;
  private contextSeq = 1;
  private answer: FakeDeviceOptions["answer"];

  /** Every CDP method the fake page was asked to run, in order. */
  readonly received: string[] = [];

  constructor(opts: FakeDeviceOptions = {}) {
    this.udid = opts.udid ?? "00008130-000000000000001E";
    this.appId = opts.appId ?? "PID:1234";
    this.appName = opts.appName ?? "Safari";
    this.bundleId = opts.bundleId ?? "com.apple.mobilesafari";
    this.answer = opts.answer;
    this.pages = opts.pages ?? [
      { pageId: 1, title: "Puppet lab", url: "https://example.test/puppet", wirType: "WIRTypeWebPage" },
      { pageId: 2, title: "ServiceWorker", url: "https://example.test/", wirType: "WIRTypeServiceWorker" },
    ];
    this.socket = new FakeSocket((frame) => this.onFrameFromBridge(frame));
    this.wi = new WebInspectorClient(this.socket as any, this.stream);
  }

  /** A Source the CDP server can be started with. */
  asSource(): Source {
    return {
      kind: "device",
      id: `device:${this.udid}`,
      label: `device:${this.udid.slice(0, 8)}`,
      wi: this.wi,
      // No lockdown client: nothing in the server requires one.
    };
  }

  /** Replace the page listing; the next listing poll reports it. */
  setPages(pages: FakePage[]) {
    this.pages = pages;
  }

  /**
   * Stop carrying traffic in both directions without closing the socket —
   * a half-open USB tunnel. Nothing is delivered and nothing errors.
   */
  goSilent() {
    this.silent = true;
  }

  /** Close the tunnel the way a cable pull or a TLS error does. */
  disconnect(err?: Error) {
    this.stream.close(err);
    this.socket.emit(err ? "error" : "close", err);
  }

  // ---- device -> bridge ---------------------------------------------------

  private emit(selector: string, argument: Record<string, PlistValue>) {
    if (this.silent) return;
    const body = encodeXml({ __selector: selector, __argument: argument });
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, body.length, false);
    this.stream.push(header);
    this.stream.push(body);
  }

  private sendApplicationList() {
    this.emit("_rpc_reportConnectedApplicationList:", {
      WIRApplicationDictionaryKey: {
        [this.appId]: {
          WIRApplicationIdentifierKey: this.appId,
          WIRApplicationNameKey: this.appName,
          WIRApplicationBundleIdentifierKey: this.bundleId,
        },
      },
    });
  }

  private sendListing() {
    const listing: Record<string, PlistValue> = {};
    for (const p of this.pages) {
      listing[String(p.pageId)] = {
        WIRPageIdentifierKey: p.pageId,
        WIRTitleKey: p.title,
        WIRURLKey: p.url,
        WIRTypeKey: p.wirType,
      };
    }
    this.emit("_rpc_applicationSentListing:", {
      WIRApplicationIdentifierKey: this.appId,
      WIRListingKey: listing,
    });
  }

  private sendToSender(senderKey: string, pageId: number, payload: unknown) {
    this.emit("_rpc_applicationSentData:", {
      WIRApplicationIdentifierKey: this.appId,
      WIRPageIdentifierKey: pageId,
      WIRDestinationKey: senderKey,
      WIRMessageDataKey: JSON.stringify(payload),
    });
  }

  // ---- bridge -> device ---------------------------------------------------

  private onFrameFromBridge(frame: Frame) {
    if (this.silent) return;
    const selector = String(frame.__selector ?? "");
    const arg = (frame.__argument as Record<string, any>) ?? {};
    switch (selector) {
      case "_rpc_reportIdentifier:":
      case "_rpc_getConnectedApplications:":
        this.sendApplicationList();
        return;
      case "_rpc_forwardGetListing:":
        this.sendListing();
        return;
      case "_rpc_forwardSocketSetup:": {
        const senderKey = String(arg.WIRSenderKey);
        const pageId = Number(arg.WIRPageIdentifierKey);
        const innerTargetId = `page-${this.nextInnerTarget++}`;
        this.senders.set(senderKey, innerTargetId);
        // Target-based mode handshake, exactly as modern WebKit does it.
        this.sendToSender(senderKey, pageId, {
          method: "Target.targetCreated",
          params: { targetInfo: { targetId: innerTargetId, type: "page", isProvisional: false } },
        });
        return;
      }
      case "_rpc_forwardDidClose:":
        this.senders.delete(String(arg.WIRSenderKey));
        return;
      case "_rpc_forwardSocketData:": {
        const senderKey = String(arg.WIRSenderKey);
        const pageId = Number(arg.WIRPageIdentifierKey);
        const raw = arg.WIRSocketDataKey;
        const text =
          typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array);
        this.onCdpFromBridge(senderKey, pageId, text);
        return;
      }
      default:
        return;
    }
  }

  /** Events WebKit pushes right after a domain is enabled. */
  private afterEnable(senderKey: string, pageId: number, method: string, envelope: string | null) {
    const page = this.pages[0]!;
    const push = (evt: any) => {
      if (envelope === null) this.sendToSender(senderKey, pageId, evt);
      else
        this.sendToSender(senderKey, pageId, {
          method: "Target.dispatchMessageFromTarget",
          params: { targetId: envelope, message: JSON.stringify(evt) },
        });
    };
    if (method === "Runtime.enable") {
      // The page's main world. Puppeteer will not evaluate until it has one.
      push({
        method: "Runtime.executionContextCreated",
        params: {
          context: {
            id: 1,
            isPageContext: true,
            type: "normal",
            name: "",
            frameId: "0.1",
          },
        },
      });
    }
    if (method === "Page.enable") {
      push({
        method: "Page.frameNavigated",
        params: {
          frame: {
            id: "0.1",
            loaderId: "0.2",
            url: page.url,
            securityOrigin: new URL(page.url).origin,
            mimeType: "text/html",
          },
        },
      });
    }
    if (method === "Page.navigate") {
      // WebKit's post-navigation sequence, in order.
      push({
        method: "Page.frameStartedLoading",
        params: { frameId: "0.1" },
      });
      push({
        method: "Page.frameNavigated",
        params: {
          frame: {
            id: "0.1",
            loaderId: `0.${++this.loaderSeq}`,
            url: page.url,
            securityOrigin: new URL(page.url).origin,
            mimeType: "text/html",
          },
        },
      });
      push({
        method: "Runtime.executionContextCreated",
        params: {
          context: { id: ++this.contextSeq, isPageContext: true, type: "normal", name: "", frameId: "0.1" },
        },
      });
      push({ method: "Page.domContentEventFired", params: { timestamp: Date.now() / 1000 } });
      push({ method: "Page.loadEventFired", params: { timestamp: Date.now() / 1000 } });
      push({ method: "Page.frameStoppedLoading", params: { frameId: "0.1" } });
    }
  }

  private onCdpFromBridge(senderKey: string, pageId: number, text: string) {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.method === "Target.sendMessageToTarget") {
      // Ack the envelope with an empty result, then deliver the real answer
      // separately — the ordering that used to confuse the bridge.
      if (typeof msg.id === "number") {
        this.sendToSender(senderKey, pageId, { id: msg.id, result: {} });
      }
      let inner: any;
      try {
        inner = JSON.parse(msg.params.message);
      } catch {
        return;
      }
      const reply = this.runCommand(inner);
      if (reply === null) return; // deliberately wedged
      this.sendToSender(senderKey, pageId, {
        method: "Target.dispatchMessageFromTarget",
        params: {
          targetId: msg.params.targetId,
          message: JSON.stringify(reply),
        },
      });
      this.afterEnable(senderKey, pageId, String(inner.method ?? ""), msg.params.targetId);
      return;
    }
    const reply = this.runCommand(msg);
    if (reply === null) return;
    this.sendToSender(senderKey, pageId, reply);
    this.afterEnable(senderKey, pageId, String(msg.method ?? ""), null);
  }

  private runCommand(msg: any): any | null {
    const method = String(msg.method ?? "");
    this.received.push(method);
    const custom = this.answer?.(method, msg.params ?? {});
    if (custom === null) return null;
    if (custom !== undefined) return { id: msg.id, result: custom };
    return { id: msg.id, result: this.builtinResult(method, msg.params ?? {}) };
  }

  private builtinResult(method: string, params: any): any {
    const page = this.pages[0]!;
    switch (method) {
      case "Page.getResourceTree":
        return {
          frameTree: {
            frame: {
              id: "0.1",
              loaderId: "0.2",
              url: page.url,
              securityOrigin: new URL(page.url).origin,
              mimeType: "text/html",
            },
            childFrames: [],
            resources: [],
          },
        };
      case "Runtime.evaluate":
      case "Runtime.callFunctionOn": {
        const expression = String(
          params.expression ?? params.functionDeclaration ?? params.functionText ?? "",
        );
        // The bridge resolves a context's global object with
        // `Runtime.evaluate("this")` before it can translate Puppeteer's
        // execution-context form of callFunctionOn.
        if (expression.trim() === "this") {
          return {
            result: {
              type: "object",
              className: "Window",
              objectId: JSON.stringify({ injectedScriptId: 1, id: 1 }),
            },
            wasThrown: false,
          };
        }
        let value: unknown = page.url;
        if (expression.includes("document.title")) value = page.title;
        if (expression.includes("document.readyState")) value = "complete";
        return { result: { type: "string", value: String(value) }, wasThrown: false };
      }
      case "DOM.getDocument":
        return {
          root: { nodeId: 1, nodeType: 9, nodeName: "#document", childNodeCount: 1, children: [] },
        };
      case "Page.navigate": {
        // Record the navigation so later evaluates report the new URL.
        if (typeof params.url === "string") this.pages[0] = { ...page, url: params.url };
        return { frameId: "0.1", loaderId: `0.${this.loaderSeq + 1}` };
      }
      default:
        return {};
    }
  }
}
