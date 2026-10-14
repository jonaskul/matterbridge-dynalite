import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { GatewayHttp, GatewayTimeoutError, GatewayUnreachableError, parseAnswer, queryString } from '../src/gateway.js';

type Handler = (url: URL, req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server | undefined;

async function gateway(handler: Handler): Promise<{ host: string; seen: URL[] }> {
  const seen: URL[] = [];
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://gw');
    seen.push(url);
    handler(url, req, res);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { host: `127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

afterEach(async () => {
  const s = server;
  server = undefined;
  if (!s) return;
  s.closeAllConnections();
  await new Promise((r) => s.close(r));
});

describe('answers', () => {
  it('are key=value lines, or a dot for nothing', () => {
    expect(parseAnswer('p=3\r\nl=40.5\n')).toEqual({ p: '3', l: '40.5' });
    expect(parseAnswer('.')).toEqual({});
  });

  it('never send a + the gateway would not understand', () => {
    expect(queryString({ a: 18, tpsp: '21.50', j: 255 })).toBe('a=18&tpsp=21.50&j=255');
  });
});

describe('the gateway over HTTP', () => {
  it('reads presets, levels, temperatures and setpoints', async () => {
    const { host, seen } = await gateway((url, _req, res) => {
      const q = url.searchParams;
      if (q.has('p')) res.end('p=5');
      else if (q.has('c')) res.end('l=29.9');
      else if (q.has('tptr')) res.end('t=23.39');
      else if (q.has('tpsp')) res.end('t=21.50');
      else res.end('.');
    });
    const gw = new GatewayHttp({ host });
    expect(await gw.getPreset(9)).toBe(5);
    expect(await gw.getLevel(9, 1)).toBe(30);
    expect(await gw.getTemperature(18)).toBe(23.39);
    expect(await gw.getSetpoint(18)).toBe(21.5);
    expect(seen.every((u) => u.pathname === '/GetDyNet.cgi')).toBe(true);
  });

  it('sends commands as the gateway wants them', async () => {
    const { host, seen } = await gateway((_u, _r, res) => res.end('.'));
    const gw = new GatewayHttp({ host });
    await gw.setPreset(24, 5, 2000);
    await gw.setLevel(9, 1, 74.6, 2000);
    await gw.setSetpoint(17, 22.5);
    expect(seen.map((u) => `${u.pathname}?${u.searchParams}`)).toEqual([
      '/SetDyNet.cgi?a=24&p=5&f=2000&j=255',
      '/SetDyNet.cgi?a=9&c=1&l=75&f=2000&j=255',
      '/SetDyNet.cgi?a=17&tpsp=22.50&j=255',
    ]);
  });

  it('asks one thing at a time', async () => {
    let open = 0;
    let most = 0;
    const { host } = await gateway((_u, _r, res) => {
      most = Math.max(most, ++open);
      setTimeout(() => {
        open--;
        res.end('p=1');
      }, 20);
    });
    const gw = new GatewayHttp({ host });
    await Promise.all([gw.getPreset(1), gw.getPreset(2), gw.getPreset(3)]);
    expect(most).toBe(1);
  });

  it('sends Basic authentication when set', async () => {
    let auth: string | undefined;
    const { host } = await gateway((_u, req, res) => {
      auth = req.headers.authorization;
      res.end('p=1');
    });
    await new GatewayHttp({ host, username: 'admin', password: 'secret' }).getPreset(1);
    expect(auth).toBe(`Basic ${Buffer.from('admin:secret').toString('base64')}`);
  });

  it('tries a slow read once more, and says so when it stays slow', async () => {
    let calls = 0;
    const { host } = await gateway((_u, _r, res) => {
      if (++calls === 1) return; // never answers
      res.end('p=2');
    });
    expect(await new GatewayHttp({ host, timeoutMs: 100 }).getPreset(1)).toBe(2);
    expect(calls).toBe(2);

    const first = server!;
    first.closeAllConnections();
    await new Promise((r) => first.close(r));
    const { host: silent } = await gateway(() => undefined);
    await expect(new GatewayHttp({ host: silent, timeoutMs: 50 }).getPreset(1)).rejects.toBeInstanceOf(GatewayTimeoutError);
  });

  it('tells an unreachable gateway apart', async () => {
    await expect(new GatewayHttp({ host: '127.0.0.1:1', timeoutMs: 200 }).getPreset(1)).rejects.toBeInstanceOf(GatewayUnreachableError);
  });
});
