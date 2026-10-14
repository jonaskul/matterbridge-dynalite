/**
 * The platform inside a real (not started) matter.js server, against a gateway
 * faked on localhost: HTTP for reads and commands, a TCP port for the bus.
 */

import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import type { MatterbridgeEndpoint, PlatformConfig } from 'matterbridge';
import {
  addMatterbridge,
  createServerNode,
  createTestEnvironment,
  destroyTestEnvironment,
  flushServerNode,
  getMatterbridge,
  log,
  setupTest,
} from 'matterbridge/test-utils/vitest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import initializePlugin from '../src/module.js';
import { type DynalitePlatform, levelToPercent, percentToLevel } from '../src/platform.js';

const bytes = (h: string) => Buffer.from(h.replace(/\s+/g, ''), 'hex');

let httpServer: http.Server;
let dynetServer: net.Server;
let busSocket: net.Socket | undefined;
const commands: string[] = [];
let platform: DynalitePlatform;

function until(cond: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => (cond() ? resolve() : Date.now() - start > ms ? reject(new Error('never happened')) : setTimeout(tick, 20));
    tick();
  });
}

function endpoint(id: string): MatterbridgeEndpoint {
  const found = platform.getDevices().find((d) => d.uniqueId === id || d.serialNumber === id || d.id === id);
  if (!found) throw new Error(`no endpoint ${id}: ${platform.getDevices().map((d) => d.serialNumber).join(', ')}`);
  return found;
}

beforeAll(async () => {
  httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://gw');
    const q = url.searchParams;
    if (url.pathname === '/SetDyNet.cgi') {
      commands.push(q.toString());
      return res.end('.');
    }
    if (q.has('tptr')) return res.end('t=21.00');
    if (q.has('tpsp')) return res.end('t=20.00');
    if (q.has('c')) return res.end('l=40');
    return res.end('p=1');
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  dynetServer = net.createServer((s) => (busSocket = s));
  await new Promise<void>((r) => dynetServer.listen(0, '127.0.0.1', r));

  await setupTest('DynalitePlatform', false);
  await createTestEnvironment();
  await createServerNode(5591);

  const config = {
    name: 'matterbridge-dynalite',
    type: 'DynamicPlatform',
    version: '0.1.0',
    debug: false,
    unregisterOnShutdown: false,
    gateways: [
      {
        name: 'Home',
        host: `127.0.0.1:${(httpServer.address() as AddressInfo).port}`,
        dynetPort: (dynetServer.address() as AddressInfo).port,
        areas: [
          { area: 9, name: 'Stairs', type: 'light', channels: [{ channel: 1 }] },
          { area: 18, name: 'Bedroom', type: 'thermostat' },
        ],
      },
    ],
  } as unknown as PlatformConfig;
  platform = initializePlugin(getMatterbridge(), log, config);
  addMatterbridge(platform);
  await platform.onStart('test');
  await platform.onConfigure();
}, 30_000);

afterAll(async () => {
  await platform?.onShutdown('test');
  busSocket?.destroy();
  await new Promise((r) => dynetServer.close(r));
  httpServer.closeAllConnections();
  await new Promise((r) => httpServer.close(r));
  await flushServerNode();
  await destroyTestEnvironment();
}, 30_000);

describe('the platform', () => {
  it('shows a channel as a dimmable light and an area as a thermostat, read from the gateway', async () => {
    const light = endpoint('dynalite-home-a9-c1');
    const room = endpoint('dynalite-home-a18');
    await until(() => light.getAttribute('onOff', 'onOff') === true);
    expect(light.getAttribute('levelControl', 'currentLevel')).toBe(percentToLevel(40));
    await until(() => room.getAttribute('thermostat', 'localTemperature') === 2100);
    expect(room.getAttribute('thermostat', 'occupiedHeatingSetpoint')).toBe(2000);
  });

  it('follows the bus as it happens', async () => {
    await until(() => busSocket !== undefined);
    busSocket!.write(bytes('ac 03 57 c3 00 46 00 12 ff 0c 17 27 00 00 ff 6a')); // area 18: 23.39 °C
    const room = endpoint('dynalite-home-a18');
    await until(() => room.getAttribute('thermostat', 'localTemperature') === 2339);

    busSocket!.write(bytes('ac 04 10 c3 00 46 00 09 ff 02 00 01 be 00 00 00 c8 00 cd 5a')); // area 9 ch 1 → 74.8 %
    const light = endpoint('dynalite-home-a9-c1');
    await until(() => light.getAttribute('levelControl', 'currentLevel') === percentToLevel(74.8));
  });

  it('sends a command from Matter to the gateway', async () => {
    const light = endpoint('dynalite-home-a9-c1');
    await light.executeCommandHandler('moveToLevelWithOnOff', { level: 127, transitionTime: 10, optionsMask: {}, optionsOverride: {} } as never, 'levelControl' as never, {} as never, light as never);
    await light.executeCommandHandler('off', {} as never, 'onOff' as never, {} as never, light as never);
    expect(commands).toEqual([`a=9&c=1&l=${Math.round(levelToPercent(127))}&f=1000&j=255`, 'a=9&c=1&l=0&f=2000&j=255']);
  });
});

describe('levels', () => {
  it('go between Matter (1–254) and percent', () => {
    expect(percentToLevel(100)).toBe(254);
    expect(percentToLevel(0)).toBe(1);
    expect(levelToPercent(254)).toBe(100);
    expect(percentToLevel(levelToPercent(190))).toBe(190);
  });
});
