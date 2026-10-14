import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { DynetEvent } from '../src/dynet.js';
import { DynetLive } from '../src/live.js';

const bytes = (h: string) => Buffer.from(h.replace(/\s+/g, ''), 'hex');
const TEMP = bytes('ac 03 57 c3 00 46 00 12 ff 0c 17 27 00 00 ff 6a');
const PRESET = bytes('ac 03 01 c3 00 46 00 18 ff 00 05 00 00 c8 f0 9d');

let server: net.Server | undefined;
let live: DynetLive | undefined;

afterEach(async () => {
  live?.stop();
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = undefined;
});

function until(cond: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => (cond() ? resolve() : Date.now() - start > ms ? reject(new Error('never happened')) : setTimeout(tick, 10));
    tick();
  });
}

describe('the DyNet port', () => {
  it('is read as it comes, across split writes, and read again after it drops', async () => {
    let connections = 0;
    server = net.createServer((socket) => {
      connections++;
      if (connections === 1) {
        socket.write(TEMP.subarray(0, 5));
        setTimeout(() => {
          socket.write(TEMP.subarray(5));
          socket.end(); // drops after one packet
        }, 20);
      } else {
        socket.write(PRESET);
      }
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    const events: DynetEvent[] = [];
    const states: boolean[] = [];
    live = new DynetLive({ host: '127.0.0.1', port, maxRetryMs: 50, onEvent: (e) => events.push(e), onConnected: (up) => states.push(up) });
    live.start();
    await until(() => events.length === 2);

    expect(events.map((e) => e.kind)).toEqual(['temperature', 'preset']);
    expect(states.slice(0, 3)).toEqual([true, false, true]);
    expect(live.connected).toBe(true);
  });

  it('keeps trying a gateway that is not there, and stops when told', async () => {
    const errors: string[] = [];
    live = new DynetLive({ host: '127.0.0.1', port: 1, maxRetryMs: 20, onEvent: () => undefined, onError: (m) => errors.push(m) });
    live.start();
    await until(() => errors.length >= 2);
    live.stop();
    const after = errors.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(errors.length).toBe(after);
  });
});
