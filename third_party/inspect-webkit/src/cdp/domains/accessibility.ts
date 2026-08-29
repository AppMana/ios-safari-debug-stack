import type { Target } from "../target";
import { swallowWith } from "../domain";

const SNAPSHOT_SELECTOR = [
  "a", "button", "input", "textarea", "select", "option", "summary",
  "h1", "h2", "h3", "h4", "h5", "h6", "img", "nav", "main",
  "header", "footer", "aside", "form", "article", "section", "p", "li",
  "dt", "dd", "td", "th", "label", "legend", "figcaption", "[role]",
].join(",");

// CDP `Accessibility` ↔ WIR. WIR exposes accessibility through the DOM
// domain (`DOM.getAccessibilityPropertiesForNode`), not a top-level
// Accessibility domain. enable/disable are no-ops on the WIR side.
//
// `getPartialAXTree` is the only method DevTools' Elements panel actually
// calls today. We forward to DOM.getAccessibilityPropertiesForNode and
// translate the response into the AXNode shape DevTools expects. The full
// fidelity translation (childIds, ignoredReasons, role/name AXValue typing)
// is large; we return a minimal node so the panel renders rather than
// erroring out. Phase 2 can flesh out the property mapping.

export function installAccessibilityFilters(t: Target) {
  t.addMessageFilter("tools::Accessibility.enable", (msg) => swallowWith(t, msg, {}));
  t.addMessageFilter("tools::Accessibility.disable", (msg) => swallowWith(t, msg, {}));

  // Puppeteer and chrome-devtools-mcp request the whole AX tree. WebKit has
  // no equivalent command, so build a compact semantic tree from the DOM.
  // Node ids come from WIR's querySelectorAll, keeping the synthesized AX
  // nodes resolvable for later click/fill operations.
  t.addMessageFilter("tools::Accessibility.getFullAXTree", async (msg) => {
    try {
      const documentResult = await t.callTarget("DOM.getDocument");
      const documentNodeId = documentResult?.root?.nodeId;
      if (typeof documentNodeId !== "number") throw new Error("no document node");

      const selected = await t.callTarget("DOM.querySelectorAll", {
        nodeId: documentNodeId,
        selector: SNAPSHOT_SELECTOR,
      });
      const nodeIds: number[] = Array.isArray(selected?.nodeIds) ? selected.nodeIds : [];
      const source = `(() => {
        const selector = ${JSON.stringify(SNAPSHOT_SELECTOR)};
        const roleFor = (element) => {
          const explicit = element.getAttribute("role");
          if (explicit) return explicit.split(/\\s+/)[0];
          const tag = element.tagName.toLowerCase();
          if (tag === "a") return "link";
          if (tag === "button" || tag === "summary") return "button";
          if (tag === "textarea") return "textbox";
          if (tag === "select") return "combobox";
          if (tag === "option") return "option";
          if (/^h[1-6]$/.test(tag)) return "heading";
          if (tag === "img") return "image";
          if (tag === "nav") return "navigation";
          if (tag === "main") return "main";
          if (tag === "header") return "banner";
          if (tag === "footer") return "contentinfo";
          if (tag === "aside") return "complementary";
          if (tag === "form") return "form";
          if (tag === "article") return "article";
          if (tag === "section") return "region";
          if (tag === "li") return "listitem";
          if (tag === "td") return "cell";
          if (tag === "th") return "columnheader";
          if (tag === "input") {
            const type = (element.type || "text").toLowerCase();
            if (["button", "submit", "reset"].includes(type)) return "button";
            if (type === "checkbox") return "checkbox";
            if (type === "radio") return "radio";
            if (type === "range") return "slider";
            if (type === "search") return "searchbox";
            return "textbox";
          }
          return tag === "p" ? "paragraph" : "StaticText";
        };
        const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, 500);
        return {
          title: document.title,
          nodes: Array.from(document.querySelectorAll(selector), (element) => {
            const name = clean(
              element.getAttribute("aria-label") || element.getAttribute("alt") ||
              element.getAttribute("title") || element.getAttribute("placeholder") ||
              element.innerText || element.textContent || element.value
            );
            return {
              role: roleFor(element),
              name,
              value: clean(element.value),
              focusable: element.matches("a[href],button,input,textarea,select,summary,[tabindex]"),
              disabled: Boolean(element.disabled),
            };
          }),
        };
      })()`;
      const evaluated = await t.callTarget("Runtime.evaluate", {
        expression: source,
        returnByValue: true,
        doNotPauseOnExceptionsAndMuteConsole: true,
      });
      const snapshot = evaluated?.result?.value ?? {};
      const descriptions: any[] = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
      const count = Math.min(nodeIds.length, descriptions.length);
      const childIds = Array.from({ length: count }, (_, index) => `ax-${nodeIds[index]}`);
      const nodes: any[] = [{
        nodeId: `ax-${documentNodeId}`,
        ignored: false,
        role: { type: "role", value: "RootWebArea" },
        name: { type: "computedString", value: String(snapshot.title ?? "") },
        backendDOMNodeId: documentNodeId,
        childIds,
        // Puppeteer's interesting-only serializer must retain the root or it
        // returns only the first interesting top-level child.
        properties: [{ name: "focusable", value: { type: "booleanOrUndefined", value: true } }],
      }];
      for (let index = 0; index < count; index++) {
        const info = descriptions[index] ?? {};
        const properties = [];
        if (info.focusable) {
          properties.push({ name: "focusable", value: { type: "booleanOrUndefined", value: true } });
        }
        if (info.disabled) {
          properties.push({ name: "disabled", value: { type: "boolean", value: true } });
        }
        nodes.push({
          nodeId: childIds[index],
          ignored: false,
          role: { type: "role", value: String(info.role || "StaticText") },
          name: { type: "computedString", value: String(info.name || "") },
          ...(info.value ? { value: { type: "string", value: String(info.value) } } : {}),
          backendDOMNodeId: nodeIds[index],
          childIds: [],
          properties,
        });
      }
      t.fireResultToTools(msg.id!, { nodes });
    } catch (error) {
      if (process.env.INSPECT_WEBKIT_DEBUG) {
        console.error("[accessibility] getFullAXTree synthesis failed:", error);
      }
      t.fireResultToTools(msg.id!, { nodes: [] });
    }
    return null;
  });

  t.addMessageFilter("tools::Accessibility.getPartialAXTree", async (msg) => {
    const params = msg.params ?? {};
    const nodeId = params.nodeId ?? params.backendNodeId;
    if (typeof nodeId !== "number") {
      t.fireResultToTools(msg.id!, { nodes: [] });
      return null;
    }
    try {
      const r = await t.callTarget("DOM.getAccessibilityPropertiesForNode", {
        nodeId,
      });
      const props = r?.properties ?? {};
      const axNode = {
        nodeId: String(nodeId),
        ignored: Boolean(props.ignored),
        role: props.role
          ? { type: "role", value: String(props.role) }
          : undefined,
        name: props.label
          ? { type: "computedString", value: String(props.label) }
          : undefined,
        backendDOMNodeId: nodeId,
        childIds: [],
        properties: [],
      };
      t.fireResultToTools(msg.id!, { nodes: [axNode] });
    } catch (e: any) {
      // Soft-fail: return an empty tree so the panel doesn't throw.
      t.fireResultToTools(msg.id!, { nodes: [] });
    }
    return null;
  });
}
