import { expect, test } from "bun:test";
import { installInputFilters } from "../cdp/domains/input";
import type { CdpMessage, Target } from "../cdp/target";

test("mouse release dispatches mouseup then click with executable expressions", async () => {
  let filter: ((message: CdpMessage) => Promise<CdpMessage | null>) | undefined;
  const expressions: string[] = [];
  const replies: number[] = [];
  const fake = {
    addMessageFilter(method: string, candidate: typeof filter) {
      if (method === "tools::Input.dispatchMouseEvent") filter = candidate;
    },
    async callTarget(_method: string, params: { expression: string }) {
      expressions.push(params.expression);
      return { result: { type: "boolean", value: true } };
    },
    fireResultToTools(id: number) {
      replies.push(id);
    },
    fireErrorToTools() {},
  } as unknown as Target;

  installInputFilters(fake);
  await filter!({
    id: 7,
    method: "Input.dispatchMouseEvent",
    params: { type: "mouseReleased", x: 10, y: 20, button: "left" },
  });

  expect(replies).toEqual([7]);
  expect(expressions).toHaveLength(2);
  expect(expressions[0]).toContain('"type":"mouseup"');
  expect(expressions[1]).toContain('"type":"click"');
  expect(expressions.every((expression) => expression.startsWith("(\nfunction __sd_simulate"))).toBe(true);
  expect(expressions.every((expression) => expression.includes("})("))).toBe(true);
});

test("runtime exceptions are returned as input errors", async () => {
  let filter: ((message: CdpMessage) => Promise<CdpMessage | null>) | undefined;
  const errors: Array<{ id: number; message: string }> = [];
  const fake = {
    addMessageFilter(method: string, candidate: typeof filter) {
      if (method === "tools::Input.dispatchMouseEvent") filter = candidate;
    },
    async callTarget() {
      return { exceptionDetails: { text: "ReferenceError" } };
    },
    fireResultToTools() {},
    fireErrorToTools(id: number, error: { message: string }) {
      errors.push({ id, message: error.message });
    },
  } as unknown as Target;

  installInputFilters(fake);
  await filter!({ id: 8, method: "Input.dispatchMouseEvent", params: { type: "mousePressed" } });
  expect(errors).toEqual([{ id: 8, message: "ReferenceError" }]);
});
