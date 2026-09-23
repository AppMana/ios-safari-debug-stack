import { test, expect } from 'bun:test';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { startEvaluationServer } from '../evaluator';

test('single evaluator reconnects to rediscovered targets without replaying timed-out commands', async () => {
  let present = true, identity = 'first', connections = 0, executions = 0;
  const discovery = http.createServer((_req, res) => res.end(JSON.stringify(present ? [{
    type: 'page', description: 'com.apple.mobilesafari', id: identity,
    url: 'https://example.test/puppet', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/${identity}`,
  }] : [])));
  const ws = new WebSocketServer({ server: discovery });
  ws.on('connection', (socket, req) => {
    connections++;
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'Runtime.evaluate') executions++;
      if (message.params?.expression === 'stall') return;
      socket.send(JSON.stringify({ id: message.id, result: { result: { value: req.url } } }));
    });
  });
  await new Promise<void>(resolve => discovery.listen(0, '127.0.0.1', resolve));
  const port = (discovery.address() as { port: number }).port;
  const evaluator = await startEvaluationServer({ discoveryUrl: `http://127.0.0.1:${port}/json/list`,
    targetUrlPrefix: 'https://example.test/', port: 0, timeoutMs: 150 });
  const endpoint = `http://127.0.0.1:${(evaluator.server.address() as { port: number }).port}`;
  const evaluate = (body: string) => fetch(endpoint, { method: 'POST', body });
  try {
    const initial = await Promise.all([evaluate('one'), evaluate('two')]);
    expect(initial.every(r => r.ok)).toBe(true); expect(connections).toBe(1);
    const timedOut = await evaluate('stall');
    expect(timedOut.status).toBe(503);
    expect((await timedOut.json() as any).error).toContain('command was not replayed');
    expect(executions).toBe(3);
    present = false;
    expect((await evaluate('absent')).status).toBe(503);
    expect(executions).toBe(3);
    present = true; identity = 'second';
    const result = await (await evaluate('new command')).json() as any;
    expect(result.result.result.value).toBe('/second');
    expect(connections).toBe(2); expect(executions).toBe(4);
    for (const socket of ws.clients) socket.terminate();
    await new Promise(resolve => setTimeout(resolve, 20));
    identity = 'third';
    const health = await (await fetch(endpoint + '/health')).json() as any;
    expect(health.target.id).toBe('third'); expect(connections).toBe(3);
  } finally {
    evaluator.close();
    for (const socket of ws.clients) socket.terminate();
    ws.close(); discovery.close();
  }
});
