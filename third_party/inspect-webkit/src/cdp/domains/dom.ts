import type { Target } from "../target";
import { swallowWith } from "../domain";

export function installDomFilters(t: Target) {
  // Guards DOM.discardSearchResults against unknown ids (Safari errors loudly).
  const knownSearches = new Set<string>();

  // WIR has no DOM.enable; DOM methods work regardless. Ack so DevTools' probe is clean.
  t.addMessageFilter("tools::DOM.enable", (msg) => swallowWith(t, msg, {}));

  // CDP uses { mode: "searchForNode" | "none" }; WIR uses { enabled: bool }.
  t.addMessageFilter("tools::DOM.setInspectMode", (msg) => {
    msg.method = "DOM.setInspectModeEnabled";
    if (msg.params) {
      msg.params.enabled = msg.params.mode === "searchForNode";
      delete msg.params.mode;
      delete msg.params.highlightConfig;
    }
    return Promise.resolve(msg);
  });

  // CDP DOM.setInspectedNode → WIR Console.addInspectedNode.
  t.addMessageFilter("tools::DOM.setInspectedNode", (msg) => {
    msg.method = "Console.addInspectedNode";
    return Promise.resolve(msg);
  });

  // Search ↔ Safari: rename only the case-sensitivity default. Safari
  // accepts the CDP shape verbatim otherwise.
  t.addMessageFilter("tools::DOM.performSearch", (msg) => {
    if (msg.params)
      msg.params = { query: msg.params.query, caseSensitive: !!msg.params.caseSensitive };
    return Promise.resolve(msg);
  });
  t.addMessageFilter("target::DOM.performSearch", (msg) => {
    const sid = msg.result?.searchId;
    if (typeof sid === "string") knownSearches.add(sid);
    return Promise.resolve(msg);
  });
  t.addMessageFilter("tools::DOM.discardSearchResults", (msg) => {
    const sid = msg.params?.searchId;
    if (typeof sid === "string") knownSearches.delete(sid);
    return Promise.resolve(msg);
  });

  // Backend-id → frontend nodeId. WIR has the singular form only.
  t.addMessageFilter("tools::DOM.pushNodesByBackendIdsToFrontend", async (msg) => {
    const ids: number[] = msg.params?.backendNodeIds ?? [];
    const results = await Promise.all(
      ids.map((id) =>
        t
          .callTarget("DOM.pushNodeByBackendIdToFrontend", { backendNodeId: id })
          .then((r) => r.nodeId)
          // Some WebKit revisions removed the singular form; fall through
          // to echoing the backendNodeId (clients use it as a hint anyway).
          .catch(() => id),
      ),
    );
    t.fireResultToTools(msg.id!, { nodeIds: results });
    return null;
  });

  // CDP getBoxModel → WIR has no equivalent, but DOM.highlightNode flashes
  // the right rectangle on screen and we can return an empty model. The
  // highlight is best-effort.
  t.addMessageFilter("tools::DOM.getBoxModel", (msg) => {
    t.callTarget("DOM.highlightNode", {
      highlightConfig: {
        showInfo: true,
        contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
        paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
        borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
        marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
      },
      nodeId: msg.params?.nodeId,
    }).catch(() => {});
    return Promise.resolve(null);
  });

  // CDP getNodeForLocation → elementFromPoint + DOM.requestNode.
  t.addMessageFilter("tools::DOM.getNodeForLocation", async (msg) => {
    try {
      const eval1 = await t.callTarget("Runtime.evaluate", {
        expression: `document.elementFromPoint(${msg.params?.x},${msg.params?.y})`,
      });
      const objectId = eval1.result?.objectId;
      if (!objectId) {
        t.fireResultToTools(msg.id!, { nodeId: 0 });
        return null;
      }
      const node = await t.callTarget("DOM.requestNode", { objectId });
      t.fireResultToTools(msg.id!, { nodeId: node.nodeId, backendNodeId: node.nodeId });
    } catch (e: any) {
      t.fireErrorToTools(msg.id!, { message: e?.message ?? String(e) });
    }
    return null;
  });

  // CDP DOM.resolveNode returns { object: RemoteObject }; WIR matches but
  // calls the numeric key nodeId rather than backendNodeId. The synthetic
  // accessibility tree deliberately uses WIR node ids as CDP backend ids.
  t.addMessageFilter("tools::DOM.resolveNode", (msg) => {
    if (msg.params) {
      if (msg.params.nodeId === undefined && typeof msg.params.backendNodeId === "number") {
        msg.params.nodeId = msg.params.backendNodeId;
      }
      delete msg.params.backendNodeId;
      delete msg.params.executionContextId;
      if (msg.params.objectGroup === undefined) delete msg.params.objectGroup;
    }
    return Promise.resolve(msg);
  });

  // WebKit has DOM.requestNode (object → node id) but not CDP's richer
  // DOM.describeNode. Puppeteer uses describeNode to verify that locator
  // handles are still connected, so synthesize the small Node shape it
  // consumes from the live JavaScript object.
  t.addMessageFilter("tools::DOM.describeNode", async (msg) => {
    const objectId = msg.params?.objectId;
    if (typeof objectId !== "string") {
      t.fireErrorToTools(msg.id!, { message: "DOM.describeNode currently requires objectId" });
      return null;
    }
    try {
      const requested = await t.callTarget("DOM.requestNode", { objectId });
      const nodeId = Number(requested?.nodeId) || 0;
      const described = await t.callTarget("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function () {
          return {
            nodeType: Number(this.nodeType || 0),
            nodeName: String(this.nodeName || ""),
            localName: String(this.localName || ""),
            nodeValue: String(this.nodeValue || ""),
            childNodeCount: Number(this.childNodes?.length || 0),
            attributes: this.attributes
              ? Array.from(this.attributes, attribute => [attribute.name, attribute.value]).flat()
              : [],
          };
        }`,
        returnByValue: true,
        doNotPauseOnExceptionsAndMuteConsole: true,
      });
      const info = described?.result?.value ?? {};
      t.fireResultToTools(msg.id!, {
        node: {
          nodeId,
          backendNodeId: nodeId,
          nodeType: info.nodeType ?? 0,
          nodeName: info.nodeName ?? "",
          localName: info.localName ?? "",
          nodeValue: info.nodeValue ?? "",
          childNodeCount: info.childNodeCount ?? 0,
          attributes: Array.isArray(info.attributes) ? info.attributes : [],
        },
      });
    } catch (error) {
      t.fireErrorToTools(msg.id!, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  });
}
