import { test, expect } from 'bun:test';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDevices, readPairRecord, connect } from '../usbmux';
import { encodeXml } from '../plist';

async function daemon(onRequest: (socket: net.Socket) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'usbmux-test-'));
  const socketPath = join(dir, 'socket');
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', () => onRequest(socket));
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  return { options: { socketPath, timeoutMs: 80 }, sockets, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true });
  }};
}

function reply(socket: net.Socket, payload: Parameters<typeof encodeXml>[0]) {
  const body = encodeXml(payload), header = Buffer.alloc(16);
  header.writeUInt32LE(body.length + 16); header.writeUInt32LE(1, 4);
  header.writeUInt32LE(8, 8); header.writeUInt32LE(1, 12);
  socket.write(Buffer.concat([header, body]));
}

test('stalled daemon requests time out, close sockets and allow later discovery', async () => {
  let respond = false;
  const d = await daemon(socket => {
    if (respond) reply(socket, { DeviceList: [] });
  });
  try {
    await expect(listDevices(d.options)).rejects.toThrow('usbmux ListDevices timed out');
    await expect(readPairRecord('test-device', d.options)).rejects.toThrow('usbmux ReadPairRecord timed out');
    await expect(connect(1, 62078, d.options)).rejects.toThrow('usbmux Connect timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(d.sockets.size).toBe(0);
    respond = true;
    expect(await listDevices(d.options)).toEqual([]);
  } finally { await d.close(); }
});

test('a truncated reply cannot hold discovery forever', async () => {
  const d = await daemon(socket => socket.write(Buffer.from([100, 0, 0, 0])));
  try { await expect(listDevices(d.options)).rejects.toThrow('timed out'); }
  finally { await d.close(); }
});

test('malformed connect frames reject and release their socket', async () => {
  const d = await daemon(socket => socket.write(Buffer.alloc(4)));
  try {
    await expect(connect(1, 62078, d.options)).rejects.toThrow('invalid usbmux frame length');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(d.sockets.size).toBe(0);
  } finally { await d.close(); }
});

test('successful connect hands off a tunnel with no handshake timer remaining', async () => {
  const d = await daemon(socket => reply(socket, { MessageType: 'Result', Number: 0 }));
  try {
    const tunnel = await connect(1, 62078, d.options);
    await new Promise(resolve => setTimeout(resolve, d.options.timeoutMs * 2));
    expect(tunnel.socket.destroyed).toBe(false);
    for (const socket of d.sockets) socket.write('live');
    expect(Buffer.from(await tunnel.stream.read(4)).toString()).toBe('live');
    tunnel.socket.destroy();
  } finally { await d.close(); }
});
