import http from 'node:http';
import { WebSocket } from 'ws';

export type EvaluationOptions = {
  discoveryUrl: string;
  targetUrlPrefix?: string;
  host?: string;
  port?: number;
  timeoutMs?: number;
};

export async function startEvaluationServer(options: EvaluationOptions) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  let socket: WebSocket | undefined;
  let target: { id: string; url: string } | undefined;
  let connecting: Promise<void> | undefined;
  let lastError = '';
  let paused: unknown = null;
  let nextId = 0;
  let stopped = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

  function disconnect(error: Error) {
    lastError = error.message;
    const old = socket;
    socket = undefined; target = undefined; paused = null;
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
    pending.clear();
    old?.terminate();
  }

  function send(method: string, params: unknown = {}): Promise<any> {
    const ws = socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Safari inspector disconnected'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => disconnect(new Error(`${method} timed out; command was not replayed`)), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }), error => { if (error && socket === ws) disconnect(error); });
    });
  }

  async function connect() {
    if (stopped) throw new Error('Evaluation server stopped');
    if (connecting) return connecting;
    if (socket?.readyState === WebSocket.OPEN) return;
    connecting = (async () => {
      const response = await fetch(options.discoveryUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`Safari discovery returned HTTP ${response.status}`);
      const pages = await response.json() as Array<{ type: string; description?: string; id: string; url: string; webSocketDebuggerUrl: string }>;
      if (stopped) throw new Error('Evaluation server stopped');
      const matches = pages.filter(page => page.type === 'page' &&
        page.description?.includes('com.apple.mobilesafari') &&
        (!options.targetUrlPrefix || page.url.startsWith(options.targetUrlPrefix)));
      if (matches.length !== 1) throw new Error(`Expected one Safari target, found ${matches.length}; configure target URL or close duplicate tabs`);
      const page = matches[0]!;
      const ws = new WebSocket(page.webSocketDebuggerUrl, { handshakeTimeout: timeoutMs });
      socket = ws;
      ws.on('error', error => { if (socket === ws) disconnect(error); });
      ws.on('close', () => { if (socket === ws) disconnect(new Error('Safari inspector connection closed')); });
      ws.on('message', raw => {
        if (socket !== ws) return;
        try {
          const message = JSON.parse(raw.toString());
          if (message.method === 'Debugger.paused') paused = message.params;
          if (message.method === 'Debugger.resumed') paused = null;
          const call = pending.get(message.id);
          if (call) { pending.delete(message.id); clearTimeout(call.timer); call.resolve(message); }
        } catch (error) { disconnect(error as Error); }
      });
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
        ws.once('close', () => reject(new Error('Safari closed during connection')));
      });
      const enabled = await send('Runtime.enable');
      if (enabled.error) throw new Error(enabled.error.message);
      target = { id: page.id, url: page.url };
      lastError = '';
    })().catch(error => { disconnect(error); throw error; }).finally(() => { connecting = undefined; });
    return connecting;
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/paused') { res.end(JSON.stringify(paused)); return; }
    try {
      await connect();
      if (req.method === 'GET' && req.url === '/health') {
        res.end(JSON.stringify({ connected: true, target })); return;
      }
      if (req.method !== 'POST') { res.writeHead(405).end(JSON.stringify({ error: 'POST required' })); return; }
      let body = '';
      for await (const chunk of req) body += chunk;
      const command = body.trimStart().startsWith('{') ? JSON.parse(body) : {
        method: 'Runtime.evaluate', params: { expression: body, returnByValue: true, awaitPromise: true, userGesture: true },
      };
      if (typeof command.method !== 'string') throw new Error('CDP method is required');
      res.end(JSON.stringify(await send(command.method, command.params)));
    } catch (error) {
      lastError = (error as Error).message;
      res.writeHead(503).end(JSON.stringify({ error: lastError, connected: socket?.readyState === WebSocket.OPEN }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 9334, options.host ?? '127.0.0.1', resolve);
  });
  return { server, close() { stopped = true; disconnect(new Error('Evaluation server stopped')); server.close(); } };
}
