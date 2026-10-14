/**
 * Watch a gateway's DyNet port from a shell, without Matterbridge: to check that
 * the port is set up right and to find area and channel numbers.
 *
 *   node dist/listen.js 192.168.1.50 50000         # decoded, heartbeats left out
 *   node dist/listen.js 192.168.1.50 50000 --all   # heartbeats and raw bytes too
 *
 * Reading only: nothing is sent to the bus. Ctrl+C to stop.
 */

import { describe, hex, isHeartbeat } from './dynet.js';
import { DynetLive } from './live.js';

const [host, portText, ...flags] = process.argv.slice(2);
const port = Number(portText);
if (!host || !Number.isInteger(port)) {
  console.error('Usage: node dist/listen.js <gateway address> <DyNet port> [--all]');
  process.exit(2);
}
const all = flags.includes('--all');
const time = () => new Date().toTimeString().slice(0, 8);
let beats = 0;

const live = new DynetLive({
  host,
  port,
  onEvent: (e) => {
    if (isHeartbeat(e)) {
      beats++;
      if (!all) return;
    }
    const text = describe(e);
    const bytes = 'packet' in e ? e.packet : e.raw;
    console.log(`${time()}  ${text}${all && !text.includes('[') ? `   [${hex(bytes)}]` : ''}`);
  },
  onConnected: (up) => console.error(`${time()}  ${up ? `connected to ${host}:${port}` : 'disconnected; trying again …'}`),
  onError: (m) => console.error(`${time()}  ${m}`),
});
live.start();
setInterval(() => {
  if (!all) console.error(`${time()}  (still listening; ${beats} heartbeat(s) from the gateway so far)`);
}, 30_000).unref();
process.on('SIGINT', () => {
  live.stop();
  process.exit(0);
});
