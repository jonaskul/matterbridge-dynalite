/**
 * Trying a gateway's settings before they are saved: does its web server
 * answer, does its DyNet port take a connection, and does anything come on it?
 * A port that connects but stays silent is one the gateway routes nothing to.
 */

import net from 'node:net';

import { GatewayHttp, GatewayTimeoutError, GatewayUnreachableError } from './gateway.js';

export interface ProbeSettings {
  host: string;
  https?: boolean;
  allowSelfSigned?: boolean;
  username?: string;
  password?: string;
  dynetPort?: number;
}

export interface ProbeResult {
  http: { ok: boolean; message: string };
  dynet?: { ok: boolean; message: string; bytes: number };
}

/** How long the DyNet port is listened to: a gateway asks "who are you?" about every three seconds. */
export const LISTEN_MS = 4000;

export async function probe(s: ProbeSettings, listenMs = LISTEN_MS): Promise<ProbeResult> {
  const result: ProbeResult = { http: await probeHttp(s) };
  if (s.dynetPort) result.dynet = await probeDynet(s.host.replace(/:\d+$/, ''), s.dynetPort, listenMs);
  return result;
}

async function probeHttp(s: ProbeSettings): Promise<ProbeResult['http']> {
  const api = new GatewayHttp({
    host: s.host,
    https: s.https,
    allowSelfSigned: s.allowSelfSigned,
    username: s.username,
    password: s.password,
    timeoutMs: 4000,
  });
  try {
    await api.getPreset(1);
    return { ok: true, message: 'The gateway answers.' };
  } catch (err) {
    const port = /:(\d+)$/.exec(s.host)?.[1];
    const hint = port && !['80', '443'].includes(port) ? ` Is ${port} its web server? Its web pages are usually on 80.` : '';
    if (err instanceof GatewayUnreachableError) return { ok: false, message: `Cannot reach it: ${err.message}.${hint}` };
    if (err instanceof GatewayTimeoutError) return { ok: false, message: `No answer in time.${hint}` };
    return { ok: false, message: `${(err as Error).message}${hint}` };
  }
}

function probeDynet(host: string, port: number, listenMs: number): Promise<NonNullable<ProbeResult['dynet']>> {
  return new Promise((resolve) => {
    let bytes = 0;
    let connected = false;
    const socket = net.connect({ host, port });
    const done = (r: NonNullable<ProbeResult['dynet']>) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => {
      if (!connected) done({ ok: false, message: `No connection to port ${port} in time.`, bytes });
    }, 4000);
    socket.on('connect', () => {
      connected = true;
      clearTimeout(timer);
      setTimeout(
        () =>
          done(
            bytes > 0
              ? { ok: true, message: `Port ${port} connects and the gateway sends on it.`, bytes }
              : {
                  ok: false,
                  message: `Port ${port} connects, but nothing came on it in ${listenMs / 1000} s. In the gateway's routing, route Comm Port 1 (the bus), Internal Messages and the Web Socket port to it.`,
                  bytes,
                },
          ),
        listenMs,
      );
    });
    socket.on('data', (d: Buffer) => (bytes += d.length));
    socket.on('error', (err: Error) => done({ ok: false, message: `Port ${port}: ${err.message}`, bytes }));
  });
}
