import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { probe } from '../src/probe.js';

const closers: Array<() => void> = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

function web(): Promise<number> {
  const server = http.createServer((_req, res) => res.end('p=1'));
  return new Promise((r) => server.listen(0, '127.0.0.1', () => {
    closers.push(() => server.close());
    r((server.address() as AddressInfo).port);
  }));
}

function dynet(send: boolean): Promise<number> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((s) => {
    sockets.push(s);
    if (send) s.write(Buffer.from('ac0482c30046aa5555000c00000000000000c89b', 'hex'));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => {
    closers.push(() => {
      sockets.forEach((s) => s.destroy());
      server.close();
    });
    r((server.address() as AddressInfo).port);
  }));
}

describe('trying a gateway before it is saved', () => {
  it('says the web pages answer and the DyNet port sends', async () => {
    const r = await probe({ host: `127.0.0.1:${await web()}`, dynetPort: await dynet(true) }, 300);
    expect(r.http.ok).toBe(true);
    expect(r.dynet).toMatchObject({ ok: true, bytes: 20 });
  });

  it('says a port that connects but stays silent needs routes', async () => {
    const r = await probe({ host: `127.0.0.1:${await web()}`, dynetPort: await dynet(false) }, 300);
    expect(r.dynet?.ok).toBe(false);
    expect(r.dynet?.message).toMatch(/route Comm Port 1/);
  });

  it('says when nothing answers, and hints at a port that is not a web server', async () => {
    const closed = await dynet(false); // a TCP port that is no web server
    const r = await probe({ host: `127.0.0.1:${closed}` }, 300);
    expect(r.http.ok).toBe(false);
    expect(r.http.message).toMatch(new RegExp(`Is ${closed} its web server`));
    expect(r.dynet).toBeUndefined();
  });
});
