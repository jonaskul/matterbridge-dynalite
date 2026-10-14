import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type DeviceSink, GatewayBridge, type GatewayApi } from '../src/bridge.js';
import { readConfig } from '../src/config.js';
import { decode } from '../src/dynet.js';

const bytes = (h: string) => Uint8Array.from(h.trim().split(/\s+/), (b) => parseInt(b, 16));

function setup(dynetPort = 0) {
  const { gateways } = readConfig({
    gateways: [
      {
        name: 'Home',
        host: 'gw',
        dynetPort,
        areas: [
          { area: 9, name: 'Stairs', type: 'light', channels: [{ channel: 1 }, { channel: 2, dimmable: false }] },
          { area: 24, name: 'Outside', type: 'light' },
          { area: 18, name: 'Bedroom', type: 'thermostat', minSetpoint: 10, maxSetpoint: 25 },
        ],
      },
    ],
  });
  const calls: string[] = [];
  const api: GatewayApi = {
    getPreset: vi.fn(async () => 1),
    getLevel: vi.fn(async (_a: number, c: number) => (c === 1 ? 40 : 0)),
    getTemperature: vi.fn(async () => 21.3),
    getSetpoint: vi.fn(async () => 20),
    setPreset: vi.fn(async (a, p, f) => void calls.push(`preset ${a} ${p} ${f}`)),
    setLevel: vi.fn(async (a, c, l, f) => void calls.push(`level ${a}/${c} ${l} ${f}`)),
    setSetpoint: vi.fn(async (a, s) => void calls.push(`setpoint ${a} ${s}`)),
  };
  const lights: Array<[string, { on: boolean; level?: number }]> = [];
  const thermostats: Array<[string, { temperature?: number; setpoint?: number }]> = [];
  const sink: DeviceSink = { light: (id, s) => lights.push([id, s]), thermostat: (id, s) => thermostats.push([id, s]) };
  const bridge = new GatewayBridge(gateways[0], api, sink, undefined, { readAfterMs: 100, staggerMs: 0 });
  return { bridge, api, calls, lights, thermostats };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the devices of a gateway', () => {
  it('are a light per channel, an area switched by preset, and a thermostat', () => {
    const { bridge } = setup();
    expect(bridge.devices.map((d) => [d.id, d.kind])).toEqual([
      ['dynalite-home-a9-c1', 'dimmable'],
      ['dynalite-home-a9-c2', 'onoff'],
      ['dynalite-home-a24', 'onoff'],
      ['dynalite-home-a18', 'thermostat'],
    ]);
  });

  it('are read in full', async () => {
    const { bridge, lights, thermostats } = setup();
    await bridge.refreshAll();
    expect(lights).toEqual([
      ['dynalite-home-a9-c1', { on: true, level: 40 }],
      ['dynalite-home-a9-c2', { on: false }],
      ['dynalite-home-a24', { on: true }],
    ]);
    expect(thermostats).toEqual([['dynalite-home-a18', { temperature: 21.3, setpoint: 20 }]]);
  });
});

describe('the bus', () => {
  it('shows a thermostat as it reports, by what byte 9 says the value is', () => {
    const { bridge, thermostats } = setup();
    bridge.handleEvent(decode(bytes('ac 03 57 c3 00 46 00 12 ff 0c 17 27 00 00 ff 6a'))); // 23.39 °C
    bridge.handleEvent(decode(bytes('ac 03 56 c3 00 46 00 12 ff 0d 15 32 00 00 0b 6d'.replace('0b 6d', checksumOf('ac 03 56 c3 00 46 00 12 ff 0d 15 32 00 00')))));
    expect(thermostats).toEqual([
      ['dynalite-home-a18', { temperature: 23.39 }],
      ['dynalite-home-a18', { setpoint: 21.5 }],
    ]);
  });

  it('switches an area light by its preset', () => {
    const { bridge, lights } = setup();
    bridge.handleEvent({ kind: 'preset', area: 24, preset: 4, packet: new Uint8Array() });
    bridge.handleEvent({ kind: 'preset', area: 24, preset: 5, packet: new Uint8Array() });
    expect(lights).toEqual([
      ['dynalite-home-a24', { on: false }],
      ['dynalite-home-a24', { on: true }],
    ]);
  });

  it('shows a level at once and reads the area once the fade is done', async () => {
    const { bridge, api, lights } = setup();
    bridge.handleEvent(decode(bytes('ac 04 10 c3 00 46 00 09 ff 02 00 01 4c 00 00 00 c8 00 21 e8'))); // ch 1 → 29.9 % over 2 s
    expect(lights).toEqual([['dynalite-home-a9-c1', { on: true, level: 29.9 }]]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(api.getLevel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(api.getLevel).toHaveBeenCalledWith(9, 1);
  });

  it('takes an answer as it is, without asking again', async () => {
    const { bridge, api, lights } = setup();
    bridge.handleEvent(decode(bytes('ac 04 23 c3 00 46 00 09 ff 00 00 01 00 00 4c 4c 00 00 fb 7d'))); // ch 1 at 29.9 %
    bridge.handleEvent(decode(bytes('ac 04 23 c3 00 46 00 09 ff 02 00 01 00 00 00 01 00 00 fc e8'))); // is at preset 1
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lights).toEqual([['dynalite-home-a9-c1', { on: true, level: 29.9 }]]);
    expect(api.getLevel).not.toHaveBeenCalled();
  });

  it('reads the channels after a preset changes the area', async () => {
    const { bridge, api } = setup();
    bridge.handleEvent(decode(bytes('ac 03 01 c3 00 46 00 09 ff 00 05 00 00 00 ' + checksumOf('ac 03 01 c3 00 46 00 09 ff 00 05 00 00 00'))));
    await vi.advanceTimersByTimeAsync(200);
    expect(api.getLevel).toHaveBeenCalledTimes(2);
  });

  it('leaves alone an area it does not show', () => {
    const { bridge, lights, thermostats } = setup();
    bridge.handleEvent({ kind: 'preset', area: 99, preset: 1, packet: new Uint8Array() });
    bridge.handleEvent({ kind: 'temperature', area: 99, temperature: 5, packet: new Uint8Array() });
    expect(lights).toEqual([]);
    expect(thermostats).toEqual([]);
  });
});

describe('commands', () => {
  it('switch a channel back on at the level it had', async () => {
    const { bridge, calls } = setup();
    await bridge.refreshAll(); // channel 1 at 40 %
    await bridge.lightOff('dynalite-home-a9-c1');
    await bridge.lightOn('dynalite-home-a9-c1');
    await bridge.lightLevel('dynalite-home-a9-c1', 75, 500);
    await bridge.lightOn('dynalite-home-a9-c2'); // a relay: full
    expect(calls).toEqual(['level 9/1 0 2000', 'level 9/1 40 2000', 'level 9/1 75 500', 'level 9/2 100 2000']);
  });

  it('switch an area by its presets', async () => {
    const { bridge, calls } = setup();
    await bridge.lightOn('dynalite-home-a24');
    await bridge.lightOff('dynalite-home-a24', 0);
    expect(calls).toEqual(['preset 24 1 2000', 'preset 24 4 0']);
  });

  it('read back without the bus to tell, once the fade is done', async () => {
    const { bridge, api } = setup();
    await bridge.lightLevel('dynalite-home-a9-c1', 50, 1000);
    await vi.advanceTimersByTimeAsync(1200);
    expect(api.getLevel).toHaveBeenCalled();
  });

  it('keep a setpoint within the thermostat and in half degrees', async () => {
    const { bridge, calls } = setup();
    expect(await bridge.setSetpoint('dynalite-home-a18', 21.3)).toBe(21.5);
    expect(await bridge.setSetpoint('dynalite-home-a18', 40)).toBe(25);
    expect(calls).toEqual(['setpoint 18 21.5', 'setpoint 18 25']);
    await expect(bridge.setSetpoint('dynalite-home-a9-c1', 20)).rejects.toThrow();
  });
});

/** The checksum bytes for a DyNet2 body, as hex. */
function checksumOf(body: string): string {
  const b = bytes(body);
  let s1 = 0;
  let s2 = 0;
  for (const x of b) {
    s1 = (s1 + x) & 0xff;
    s2 = (s2 + s1) & 0xff;
  }
  return [s2, s1].map((n) => n.toString(16).padStart(2, '0')).join(' ');
}
