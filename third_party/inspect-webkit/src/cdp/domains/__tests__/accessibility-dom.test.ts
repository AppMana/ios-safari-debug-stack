import { expect, test } from "bun:test";
import { installAccessibilityFilters } from "../accessibility";
import { installCdpOnlyStubs } from "../cdp-only-stubs";
import { installDomFilters } from "../dom";
import type { CdpMessage, Target } from "../../target";

function makeFakeTarget() {
  const filters = new Map<string, ((message: CdpMessage) => Promise<CdpMessage | null>)[]>();
  const replies: Array<{ id: number; result: any }> = [];
  const calls: Array<{ method: string; params: any }> = [];
  const fake = {
    addMessageFilter(method: string, filter: (message: CdpMessage) => Promise<CdpMessage | null>) {
      const list = filters.get(method) ?? [];
      list.push(filter);
      filters.set(method, list);
    },
    fireResultToTools(id: number, result: any) {
      replies.push({ id, result });
    },
    async callTarget(method: string, params: any) {
      calls.push({ method, params });
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelectorAll") return { nodeIds: [11, 12] };
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              title: "Test page",
              nodes: [
                { role: "heading", name: "Welcome", focusable: false, disabled: false },
                { role: "button", name: "Continue", focusable: true, disabled: false },
              ],
            },
          },
        };
      }
      if (method === "DOM.requestNode") return { nodeId: 12 };
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value: {
              nodeType: 1,
              nodeName: "BUTTON",
              localName: "button",
              nodeValue: "",
              childNodeCount: 1,
              attributes: ["type", "button"],
            },
          },
        };
      }
      throw new Error(`unexpected call: ${method}`);
    },
  };

  async function run(method: string, message: CdpMessage) {
    let current: CdpMessage | null = message;
    for (const filter of filters.get(method) ?? []) {
      if (!current) break;
      current = await filter(current);
    }
    return current;
  }

  return { fake: fake as unknown as Target, replies, calls, run };
}

test("Accessibility.getFullAXTree synthesizes resolvable semantic nodes", async () => {
  const { fake, replies, calls, run } = makeFakeTarget();
  // Match production ordering: the generic safety stubs are registered first.
  installCdpOnlyStubs(fake);
  installAccessibilityFilters(fake);

  const forwarded = await run("tools::Accessibility.getFullAXTree", {
    id: 41,
    method: "Accessibility.getFullAXTree",
    params: {},
  });

  expect(forwarded).toBeNull();
  expect(calls.map((call) => call.method)).toEqual([
    "DOM.getDocument",
    "DOM.querySelectorAll",
    "Runtime.evaluate",
  ]);
  expect(replies).toHaveLength(1);
  const nodes = replies[0].result.nodes;
  expect(nodes[0].role.value).toBe("RootWebArea");
  expect(nodes[0].properties[0].name).toBe("focusable");
  expect(nodes[0].childIds).toEqual(["ax-11", "ax-12"]);
  expect(nodes[1].backendDOMNodeId).toBe(11);
  expect(nodes[2].name.value).toBe("Continue");
  expect(nodes[2].properties[0].name).toBe("focusable");
});

test("DOM.resolveNode translates a synthetic backend id for WebKit", async () => {
  const { fake, run } = makeFakeTarget();
  installDomFilters(fake);
  const message: CdpMessage = {
    id: 42,
    method: "DOM.resolveNode",
    params: { backendNodeId: 12, executionContextId: 7 },
  };

  const forwarded = await run("tools::DOM.resolveNode", message);

  expect(forwarded!.params).toEqual({ nodeId: 12 });
});

test("DOM.describeNode synthesizes the CDP node shape from an object", async () => {
  const { fake, replies, run } = makeFakeTarget();
  installDomFilters(fake);

  const forwarded = await run("tools::DOM.describeNode", {
    id: 43,
    method: "DOM.describeNode",
    params: { objectId: '{"injectedScriptId":1,"id":2}' },
  });

  expect(forwarded).toBeNull();
  expect(replies[0].result.node).toMatchObject({
    nodeId: 12,
    backendNodeId: 12,
    nodeType: 1,
    nodeName: "BUTTON",
    localName: "button",
    attributes: ["type", "button"],
  });
});
