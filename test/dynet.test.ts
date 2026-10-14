import { describe as group, expect, it } from 'vitest';

import {
  checksum8,
  decode,
  describe,
  DynetFramer,
  dynet1Packet,
  dynet1Percent,
  dynet2Packet,
  DynetStreamDecoder,
  isHeartbeat,
  fletcher16,
} from '../src/dynet.js';

const bytes = (h: string) => Uint8Array.from(h.trim().split(/\s+/), (b) => parseInt(b, 16));

/** Packets read off a PDEG's DyNet2 port, beside what Dynalite's own monitor (or the traffic) made of them. */
const SEEN: Array<[string, string]> = [
  ['ac 03 01 c3 00 46 00 12 ff 00 04 00 00 00 fa ce', 'area 18: → preset 4'], // Recall Preset Off (4), fade 0 s
  ['ac 03 01 c3 00 46 00 18 ff 00 05 00 00 c8 f0 9d', 'area 24: → preset 5 over 2 s'], // Kveld (5), 2.00 s
  ['ac 03 01 c3 00 46 00 14 ff 00 01 00 00 00 fc cd', 'area 20: → preset 1'], // High (1)
  ['ac 03 57 c3 00 46 00 12 ff 0c 17 27 00 00 ff 6a', 'area 18: 23.39 °C'], // Reply with Actual temperature
  ['ac 03 57 c3 00 46 00 11 ff 0c 17 57 00 00 88 99', 'area 17: 23.87 °C'],
  ['ac 03 57 c3 00 46 00 13 ff 0c 14 18 00 00 cd 59', 'area 19: 20.24 °C'],
  ['ac 03 56 c3 00 46 00 11 ff 0d 15 32 00 00 0a 72', 'area 17: set to 21.50 °C'], // setpoint changed at the thermostat
  ['ac 03 56 c3 00 46 00 11 ff 0d 16 32 00 00 0e 73', 'area 17: set to 22.50 °C'],
  ['ac 04 88 c3 00 46 aa 55 55 00 02 12 25 23 ff ff ff 00 da ee', 'time set to 12:25:23'],
  ['ac 04 10 c3 00 46 00 09 ff 02 00 01 4c 00 00 00 c8 00 21 e8', 'area 9 ch 1: → 30 % over 2 s'], // set to 30 %
  ['ac 04 10 c3 00 46 00 09 ff 02 00 01 be 00 00 00 c8 00 cd 5a', 'area 9 ch 1: → 75 % over 2 s'], // set to 75 %
  ['ac 02 20 c3 00 46 00 09 ff 00 96 df', 'area 9: preset asked'],
  ['ac 04 23 c3 00 46 00 09 ff 02 00 01 00 00 00 01 00 00 fc e8', 'area 9: is at preset 1'],
  ['ac 03 22 c3 00 46 00 09 ff 00 00 01 00 00 3a e3', 'area 9 ch 1: level asked'],
  ['ac 04 23 c3 00 46 00 09 ff 00 00 01 00 00 4c 4c 00 00 fb 7d', 'area 9 ch 1: at 30 % (going to 30 %)'],
];

group('DyNet2 as read off a gateway', () => {
  it.each(SEEN)('%s', (h, text) => {
    const raw = bytes(h);
    const [packet] = new DynetFramer().feed(raw);
    expect(packet).toEqual(raw); // the length byte and the checksum hold
    expect(describe(decode(raw))).toBe(text);
  });

  it('checksum is Fletcher-16, the second sum first', () => {
    for (const [h] of SEEN) {
      const raw = bytes(h);
      expect(fletcher16(raw, raw.length - 2)).toEqual([raw[raw.length - 2], raw[raw.length - 1]]);
      expect(dynet2Packet(raw.subarray(0, raw.length - 2))).toEqual(raw);
    }
  });

  it('gives fields, not just text', () => {
    expect(decode(bytes(SEEN[1][0]))).toMatchObject({ kind: 'preset', area: 24, preset: 5, fade: 2 });
    expect(decode(bytes(SEEN[3][0]))).toMatchObject({ kind: 'temperature', area: 18, temperature: 23.39 });
    expect(decode(bytes(SEEN[6][0]))).toMatchObject({ kind: 'setpoint', area: 17, setpoint: 21.5 });
    expect(decode(bytes(SEEN[9][0]))).toMatchObject({ kind: 'channel', area: 9, channel: 1 });
    expect(decode(bytes(SEEN[9][0]))).not.toHaveProperty('reported');
    expect(decode(bytes(SEEN[14][0]))).toMatchObject({ kind: 'channel', reported: true, current: 30 });
  });

  it('takes a thermostat value by byte 9, not by the command', () => {
    // A reply (0x57) carrying the setpoint (0x0D) is the setpoint, not the room's temperature.
    const head = [0xac, 0x03, 0x57, 0xc3, 0x00, 0x46, 0x00, 0x05, 0xff];
    expect(decode(dynet2Packet([...head, 0x0d, 12, 0, 0, 0]))).toMatchObject({ kind: 'setpoint', area: 5, setpoint: 12 });
    expect(decode(dynet2Packet([...head, 0x0e, 12, 0, 0, 0])).kind).toBe('unknown');
  });

  it('reads the question a thermostat reply answers', () => {
    // Captured on 12D: the gateway asking area 14 for its temperature, then its setpoint.
    expect(decode(bytes('ac 03 55 c3 00 46 00 0e ff 0c 00 00 00 00 fa 26'))).toMatchObject({ kind: 'request', area: 14, asks: 'temperature' });
    expect(decode(bytes('ac 03 55 c3 00 46 00 0e ff 0d 00 00 00 00 ff 27'))).toMatchObject({ kind: 'request', area: 14, asks: 'setpoint' });
  });

  it('reads a device saying it has started', () => {
    // Captured on 12D after the gateway was reset; Dynalite's monitor: "Reply Device reset (F/W Version v01.46, IPv4 Address: 10.10.2.100 …)".
    const hello = bytes('ac 0a 81 c3 00 46 aa 55 55 00 00 00 01 46 ef ef 01 00 03 0a 0a 02 64 fe 80 00 00 00 00 00 00 02 01 c0 ff fe 30 19 02 00 00 00 6a c0');
    expect(describe(decode(hello))).toBe('device 0xc3 box 70 started: firmware v01.46, 10.10.2.100');
  });

  it('reads the gateway asking every device who it is', () => {
    const beat = decode(bytes('ac 04 82 c3 00 46 aa 55 55 00 0c 00 00 00 00 00 00 00 c8 9b'));
    expect(describe(beat)).toBe('"who are you?" to all devices');
    expect(isHeartbeat(beat)).toBe(true);
    expect(isHeartbeat(decode(dynet1Packet(5, 0x00)))).toBe(false);
  });
});

group('DyNet 1', () => {
  it('checksum makes the eight add up to zero', () => {
    const p = dynet1Packet(5, 0x00);
    expect(p.reduce((a, b) => a + b, 0) & 0xff).toBe(0);
    expect(checksum8(p)).toBe(p[7]);
  });

  it('levels go upside down', () => {
    expect(dynet1Percent(0x01)).toBe(100);
    expect(dynet1Percent(0xff)).toBe(0);
  });

  it.each([
    [0x00, 0, 1],
    [0x03, 0, 4],
    [0x0a, 0, 5],
    [0x0d, 0, 8],
    [0x00, 1, 9],
    [0x0b, 2, 22],
  ])('opcode %i in bank %i is preset %i', (opcode, bank, preset) => {
    expect(decode(dynet1Packet(7, opcode, 100, 0, bank))).toMatchObject({ kind: 'preset', area: 7, preset, fade: 2 });
  });

  it('reads reports, off, channel commands and fades', () => {
    expect(decode(dynet1Packet(3, 0x62, 2))).toMatchObject({ kind: 'preset', preset: 3, reported: true });
    expect(decode(dynet1Packet(3, 0x04, 50))).toMatchObject({ kind: 'off', fade: 1 });
    expect(decode(dynet1Packet(12, 0x60, 2, 0x01, 0xff))).toMatchObject({ kind: 'channel', channel: 3, level: 100, current: 0, reported: true });
    expect(decode(dynet1Packet(1, 0x81, 0x80, 0x00, 100))).toMatchObject({ kind: 'channel', channel: 6, fade: 2 });
    expect(decode(dynet1Packet(1, 0x73, 1, 0x01, 3))).toMatchObject({ kind: 'channel', channel: 2, level: 100, fade: 3 });
    const all = decode(dynet1Packet(1, 0x71, 0xff, 0xff, 0));
    expect(all).toMatchObject({ kind: 'channel', level: 0 });
    expect('channel' in all && all.channel).toBeFalsy();
  });
});

group('the framer', () => {
  it('finds packets across reads and keeps what it skipped', () => {
    const a = dynet1Packet(1, 0x00);
    const b = bytes(SEEN[0][0]);
    const stream = Uint8Array.from([0x00, 0x1c, 0x99, ...a, ...b]);
    const f = new DynetFramer();
    const got = [...f.feed(stream.subarray(0, 6)), ...f.feed(stream.subarray(6, 13)), ...f.feed(stream.subarray(13))];
    expect(got).toEqual([a, b]);
    expect(f.dropped).toBe(3);
    expect(f.takeSkipped()).toEqual(Uint8Array.from([0x00, 0x1c, 0x99]));
  });

  it('does not take a packet with a bad checksum', () => {
    const bad = bytes(SEEN[0][0]);
    bad[bad.length - 1] ^= 1;
    const decoder = new DynetStreamDecoder();
    const events = decoder.feed([...bad, ...dynet1Packet(2, 0x00)]);
    expect(events.map((e) => e.kind)).toEqual(['skipped', 'preset']);
  });
});
