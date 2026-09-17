import { expect, test } from "bun:test";
import { Target } from "../cdp/target";

function harness() {
  const toTools: string[] = [];
  const toTarget: string[] = [];
  const ws = { readyState: 1, send: (message: string) => toTools.push(message) };
  const wi = {
    forwardSocketData(_appId: string, _pageId: number, _senderKey: string, data: Uint8Array) {
      toTarget.push(new TextDecoder().decode(data));
    },
  };
  const target = new Target(ws as any, wi as any, "app", 1, "sender");
  return { target, toTools, toTarget };
}

test("inner response cannot be consumed as its wrapper acknowledgement", async () => {
  const { target, toTarget } = harness();
  await target.onMessageFromTarget(
    JSON.stringify({
      method: "Target.targetCreated",
      params: { targetInfo: { type: "page", targetId: "inner-page" } },
    }),
  );

  const resultPromise = target.callTarget("Runtime.evaluate", { expression: "1 + 1" });
  const envelope = JSON.parse(toTarget.at(-1)!);
  const inner = JSON.parse(envelope.params.message);

  expect(envelope.id).not.toBe(inner.id);
  expect(Math.abs(envelope.id) % 2).toBe(0);
  expect(inner.id % 2).not.toBe(0);

  // This is the race seen on a real iPhone: the fast evaluate result arrives
  // before Target.sendMessageToTarget acknowledges the envelope.
  await target.onMessageFromTarget(
    JSON.stringify({
      method: "Target.dispatchMessageFromTarget",
      params: { targetId: "inner-page", message: JSON.stringify({ id: inner.id, result: { value: 2 } }) },
    }),
  );
  await target.onMessageFromTarget(JSON.stringify({ id: envelope.id, result: {} }));

  expect(await resultPromise).toEqual({ value: 2 });
});
