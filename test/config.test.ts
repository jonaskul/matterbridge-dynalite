import { describe, expect, it } from 'vitest';

import { deviceId, readConfig } from '../src/config.js';

describe('the configuration', () => {
  it('fills in defaults', () => {
    const { gateways, problems } = readConfig({
      gateways: [
        {
          name: 'Home',
          host: '10.0.0.5',
          dynetPort: 50000,
          areas: [
            { area: 9, name: 'Stairs', type: 'light', channels: [{ channel: 1 }, { channel: 2, name: 'Wall', dimmable: false }] },
            { area: 24, name: 'Outside', type: 'light' },
            { area: 18, name: 'Bedroom', type: 'thermostat' },
          ],
        },
      ],
    });
    expect(problems).toEqual([]);
    const [gw] = gateways;
    expect(gw).toMatchObject({ name: 'Home', https: false, dynetPort: 50000, pollMinutes: 60, fadeSeconds: 2 });
    expect(gw.areas[0]).toMatchObject({
      type: 'light',
      channels: [
        { channel: 1, name: 'Stairs 1', dimmable: true },
        { channel: 2, name: 'Wall', dimmable: false },
      ],
    });
    expect(gw.areas[1]).toMatchObject({ type: 'light', channels: [], onPreset: 1, offPreset: 4 });
    expect(gw.areas[2]).toMatchObject({ type: 'thermostat', minSetpoint: 5, maxSetpoint: 30 });
  });

  it('polls more often without a live port', () => {
    const { gateways } = readConfig({ gateways: [{ name: 'A', host: 'gw', areas: [{ area: 1, name: 'x' }] }] });
    expect(gateways[0]).toMatchObject({ dynetPort: 0, pollMinutes: 5 });
  });

  it('says what it cannot use and leaves it out', () => {
    const { gateways, problems } = readConfig({
      gateways: [
        { name: 'A', host: '', areas: [] },
        { name: 'B', host: 'gw', areas: [{ area: 0, name: 'zero' }, { area: 3, name: 'x' }, { area: 3, name: 'again' }, { area: 4, type: 'fan' }] },
        { name: 'b', host: 'other', areas: [] },
      ],
    });
    expect(gateways.map((g) => g.name)).toEqual(['B']);
    expect(gateways[0].areas.map((a) => a.area)).toEqual([3, 4]);
    expect(problems).toHaveLength(5);
    expect(readConfig({}).problems[0]).toMatch(/No gateways/);
  });

  it('says when the address carries the DyNet port', () => {
    const { problems } = readConfig({ gateways: [{ name: 'A', host: '10.0.0.5:50000', dynetPort: 50000, areas: [{ area: 1 }] }] });
    expect(problems).toEqual([expect.stringMatching(/DyNet port \(50000\).*leave the port out/)]);
  });

  it('gives every device a stable identity', () => {
    expect(deviceId('12D Home!', 9, 1)).toBe('dynalite-12d-home-a9-c1');
    expect(deviceId('12D Home!', 18)).toBe('dynalite-12d-home-a18');
  });
});
