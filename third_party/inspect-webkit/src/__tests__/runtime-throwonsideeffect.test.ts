import { test, expect } from "bun:test";
import { installRuntimeFilters } from "../cdp/domains/runtime";
import { makeDomainCtx } from "../cdp/domain";
import type { Target } from "../cdp/target";
import type { CdpMessage } from "../cdp/target";

// Minimal Target stand-in for filter tests. We exercise the filter
// pipeline directly: register filters, hand it a tools-side message,
// observe what it forwards (return value) vs replies synchronously
// (fireResultToTools).
function makeFakeTarget() {
  const filters = new Map<string, ((m: CdpMessage) => Promise<CdpMessage | null>)[]>();
  const replies: Array<{ id: number; result: any }> = [];
  const errors: Array<{ id: number; error: any }> = [];
  const events: Array<{ method: string; params: any }> = [];
  const calls: Array<{ method: string; params: any }> = [];
  const fake = {
    addMessageFilter(method: string, f: (m: CdpMessage) => Promise<CdpMessage | null>) {
      let list = filters.get(method);
      if (!list) filters.set(method, (list = []));
      list.push(f);
    },
    fireResultToTools(id: number, result: any) {
      replies.push({ id, result });
    },
    fireErrorToTools(id: number, error: any) {
      errors.push({ id, error });
    },
    async callTarget(method: string, params: any) {
      calls.push({ method, params });
      return {
        result: {
          type: "object",
          objectId: '{"injectedScriptId":1,"id":99}',
        },
        wasThrown: false,
      };
    },
    fireEventToTools(method: string, params: any) {
      events.push({ method, params });
    },
  };
  async function runFilters(method: string, msg: CdpMessage) {
    const list = filters.get(method) ?? [];
    let cur: CdpMessage | null = msg;
    for (const f of list) {
      if (!cur) break;
      cur = await f(cur);
    }
    return cur;
  }
  return { fake: fake as unknown as Target, runFilters, replies, errors, events, calls };
}

test("Runtime.evaluate with throwOnSideEffect:true is short-circuited at the bridge", async () => {
  const { fake, runFilters, replies } = makeFakeTarget();
  installRuntimeFilters(fake, makeDomainCtx());

  const msg: CdpMessage = {
    id: 7,
    method: "Runtime.evaluate",
    params: {
      expression: "window.__probe = 42",
      throwOnSideEffect: true,
      timeout: 250,
      silent: true,
    },
  };

  const forwarded = await runFilters("tools::Runtime.evaluate", msg);

  // Must NOT forward to Safari.
  expect(forwarded).toBeNull();

  // Must reply synchronously with a side-effect EvalError, in CDP shape.
  expect(replies).toHaveLength(1);
  expect(replies[0].id).toBe(7);
  const r = replies[0].result;
  expect(r.exceptionDetails).toBeDefined();
  expect(r.exceptionDetails.text).toMatch(/side-effect/);
  expect(r.result.subtype).toBe("error");
  expect(r.result.className).toBe("EvalError");
});

test("Runtime.callFunctionOn converts a CDP executionContextId to a WIR objectId", async () => {
  const { fake, runFilters, calls, errors } = makeFakeTarget();
  installRuntimeFilters(fake, makeDomainCtx());

  const msg: CdpMessage = {
    id: 9,
    method: "Runtime.callFunctionOn",
    params: {
      functionDeclaration: "function () { return this.location.href; }",
      executionContextId: 7,
      arguments: [],
      returnByValue: true,
      awaitPromise: true,
      silent: true,
      userGesture: true,
      objectGroup: "console",
      serializationOptions: { serialization: "deep" },
    },
  };

  const forwarded = await runFilters("tools::Runtime.callFunctionOn", msg);

  expect(errors).toHaveLength(0);
  expect(calls).toEqual([
    {
      method: "Runtime.evaluate",
      params: { expression: "this", contextId: 7, objectGroup: "console" },
    },
  ]);
  expect(forwarded!.params.objectId).toBe('{"injectedScriptId":1,"id":99}');
  expect(forwarded!.params.executionContextId).toBeUndefined();
  expect(forwarded!.params.objectGroup).toBeUndefined();
  expect(forwarded!.params.serializationOptions).toBeUndefined();
  expect(forwarded!.params.doNotPauseOnExceptionsAndMuteConsole).toBe(true);
  expect(forwarded!.params.emulateUserGesture).toBe(true);
});

test("Runtime.callFunctionOn keeps DOM arguments in their WebKit world", async () => {
  const { fake, runFilters, calls } = makeFakeTarget();
  installRuntimeFilters(fake, makeDomainCtx());

  await runFilters("tools::Runtime.callFunctionOn", {
    id: 10,
    method: "Runtime.callFunctionOn",
    params: {
      functionDeclaration: "node => node",
      executionContextId: 66,
      arguments: [{ objectId: '{"injectedScriptId":62,"id":1}' }],
    },
  });

  expect(calls[0]).toEqual({
    method: "Runtime.evaluate",
    params: { expression: "this", contextId: 62 },
  });
});

test("only the normal WebKit context is advertised as the default realm", async () => {
  const { fake, runFilters } = makeFakeTarget();
  installRuntimeFilters(fake, makeDomainCtx());

  const normal = await runFilters("target::Runtime.executionContextCreated", {
    method: "Runtime.executionContextCreated",
    params: { context: { id: 7, type: "normal", name: "", frameId: "0.1" } },
  });
  const internal = await runFilters("target::Runtime.executionContextCreated", {
    method: "Runtime.executionContextCreated",
    params: {
      context: { id: 8, type: "internal", name: "Safari helper", frameId: "0.1" },
    },
  });

  expect(normal!.params.context.auxData.isDefault).toBe(true);
  expect(internal!.params.context.auxData.isDefault).toBe(false);
});

test("Runtime.evaluate without throwOnSideEffect is forwarded (silent/userGesture renamed)", async () => {
  const { fake, runFilters, replies } = makeFakeTarget();
  installRuntimeFilters(fake, makeDomainCtx());

  const msg: CdpMessage = {
    id: 8,
    method: "Runtime.evaluate",
    params: {
      expression: "1 + 1",
      silent: true,
      userGesture: true,
    },
  };

  const forwarded = await runFilters("tools::Runtime.evaluate", msg);

  // Forwarded, no synthetic reply.
  expect(forwarded).not.toBeNull();
  expect(replies).toHaveLength(0);
  // CDP-only field renames applied.
  expect(forwarded!.params.doNotPauseOnExceptionsAndMuteConsole).toBe(true);
  expect(forwarded!.params.emulateUserGesture).toBe(true);
  expect(forwarded!.params.silent).toBeUndefined();
  expect(forwarded!.params.userGesture).toBeUndefined();
});
