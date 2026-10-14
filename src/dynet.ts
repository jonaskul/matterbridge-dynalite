/**
 * DyNet, the Dynalite bus, as it comes off an Ethernet gateway's TCP port.
 *
 * A gateway (PDEG, DDNG and kin) can pass the bus through on a raw TCP server
 * port (connection "Trunk" in its setup). Every packet then arrives as it is
 * sent: a preset chosen at a wall panel, a channel faded, a thermostat's
 * temperature. This module cuts that byte stream into packets, checks them and
 * says what they mean. It never builds anything to send.
 *
 * DyNet 1 — eight bytes:
 *
 *     sync  area  d1  opcode  d2  d3  join  checksum
 *
 * sync 0x1C for a logical (area) message, 0x5C for one to a device, 0x6C for a
 * debug line; the eight add up to 0 (mod 256). Levels go upside down: 0x01 is
 * full, 0xFF is off.
 *
 * DyNet2 — sync 0xAC, then a length byte: four bytes of head and four per word
 * after it, the last two a Fletcher-16 of all before (the running sum of sums
 * first, then the sum). Area messages carry a 16-bit area at bytes 6–7 and a
 * join at 8. Checked against Dynalite's own monitor reading the same packets:
 *
 *     0x01  area went to a preset: preset (1-based) at 10, fade at 11–13 in
 *           hundredths of a second
 *     0x57  a thermostat's reply, 0x56 the same sent as its setpoint changes:
 *           byte 9 says what the value is — 0x0C the temperature, 0x0D the
 *           setpoint — whole degrees at 10, hundredths at 11
 *     0x88  the time set on the devices: hh mm ss at 11–13, BCD
 *
 * Read from the traffic around a gateway's own commands and reads:
 *
 *     0x10  a channel set to a level: channel at 10–11, level at 12 (out of
 *           254), fade at 14–16 in hundredths
 *     0x20  "which preset is the area at?"
 *     0x22  "which level is the channel at?": channel at 10–11
 *     0x23  the answer: kind at 9 (2 a preset, 0 a channel), channel at
 *           10–11; a preset at 15, or a level going to at 14 and now at 15
 *
 * Anything else is passed on raw rather than guessed at.
 */

export const SYNC_LOGICAL = 0x1c;
export const SYNC_DEVICE = 0x5c;
export const SYNC_DEBUG = 0x6c;
export const SYNC_DYNET2 = 0xac;
const SYNCS_1 = new Set([SYNC_LOGICAL, SYNC_DEVICE, SYNC_DEBUG]);
const DYNET1_LENGTH = 8;

/** What a packet said. Levels are percentages, temperatures °C, fades seconds. */
export type DynetEvent =
  /** An area went to a preset (chosen, or reported back when `reported`). Area-wide unless `channel`. */
  | { kind: 'preset'; area: number; preset: number; channel?: number; fade?: number; reported?: boolean; packet: Uint8Array }
  /** An area was switched off (DyNet 1). */
  | { kind: 'off'; area: number; fade?: number; packet: Uint8Array }
  /** A channel's level: set (`level` is where it is going) or reported (`current` is where it is now). Area-wide unless `channel`. */
  | { kind: 'channel'; area: number; channel?: number; level: number; current?: number; fade?: number; reported?: boolean; packet: Uint8Array }
  /** A fade was stopped. Area-wide unless `channel`. */
  | { kind: 'stop'; area: number; channel?: number; packet: Uint8Array }
  /** Someone asked something. */
  | { kind: 'request'; area: number; asks: 'preset' | 'level' | 'temperature'; channel?: number; packet: Uint8Array }
  | { kind: 'temperature'; area: number; temperature: number; packet: Uint8Array }
  | { kind: 'setpoint'; area: number; setpoint: number; packet: Uint8Array }
  /** The time set on the devices, hh:mm:ss. */
  | { kind: 'time'; clock: string; packet: Uint8Array }
  /** A packet whose checksum holds but whose meaning is not known. */
  | { kind: 'unknown'; area?: number; packet: Uint8Array }
  /** Bytes that made no packet. */
  | { kind: 'skipped'; raw: Uint8Array };

export type DynetEventKind = DynetEvent['kind'];

/** The eighth byte of a DyNet 1 packet: what makes the eight add up to 0. */
export function checksum8(first7: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += first7[i];
  return -sum & 0xff;
}

/** The last two bytes of a DyNet2 packet: the sum of the sums, then the sum. */
export function fletcher16(data: ArrayLike<number>, length = data.length): [number, number] {
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < length; i++) {
    s1 = (s1 + data[i]) & 0xff;
    s2 = (s2 + s1) & 0xff;
  }
  return [s2, s1];
}

/** A DyNet 1 level byte as a percentage: 0x01 is full, 0xFF off. */
export function dynet1Percent(raw: number): number {
  const r = Math.min(Math.max(raw, 1), 255);
  return round1(((255 - r) / 254) * 100);
}

/** A DyNet2 level byte as a percentage: 0 off, 254 (or more) full. */
export function dynet2Percent(raw: number): number {
  return round1((Math.min(raw, 254) / 254) * 100);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function hex(data: ArrayLike<number>): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** A DyNet 1 logical packet, for tests and tools. */
export function dynet1Packet(area: number, opcode: number, d1 = 0, d2 = 0, d3 = 0, join = 0xff): Uint8Array {
  const head = [SYNC_LOGICAL, area, d1, opcode, d2, d3, join];
  return Uint8Array.from([...head, checksum8(head)]);
}

/** A DyNet2 packet from all but its checksum, for tests and tools. */
export function dynet2Packet(body: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(body.length + 2);
  out.set(Array.from(body));
  const [a, b] = fletcher16(body);
  out[body.length] = a;
  out[body.length + 1] = b;
  return out;
}

/**
 * Cuts a byte stream into packets. TCP gives bytes, not packets, and a
 * connection may start halfway through one: bytes are dropped until a sync
 * byte starts a packet whose checksum holds. What was dropped is kept until
 * taken, so a stream that is neither protocol still shows what it sent.
 */
export class DynetFramer {
  private buf: number[] = [];
  private skipped: number[] = [];
  /** Bytes thrown away so far to find the next packet. */
  dropped = 0;

  feed(data: ArrayLike<number>): Uint8Array[] {
    for (let i = 0; i < data.length; i++) this.buf.push(data[i]);
    const out: Uint8Array[] = [];
    const buf = this.buf;
    while (buf.length > 0) {
      const sync = buf[0];
      if (sync === SYNC_DYNET2) {
        if (buf.length < 2) break;
        const n = 4 + 4 * buf[1];
        if (buf.length < n) break; // the rest is still to come
        if (buf[1] > 0) {
          const [a, b] = fletcher16(buf, n - 2);
          if (a === buf[n - 2] && b === buf[n - 1]) {
            out.push(Uint8Array.from(buf.splice(0, n)));
            continue;
          }
        }
      } else if (SYNCS_1.has(sync)) {
        if (buf.length < DYNET1_LENGTH) break;
        let sum = 0;
        for (let i = 0; i < DYNET1_LENGTH; i++) sum += buf[i];
        if ((sum & 0xff) === 0) {
          out.push(Uint8Array.from(buf.splice(0, DYNET1_LENGTH)));
          continue;
        }
      }
      this.skipped.push(buf.shift() as number);
      this.dropped++;
    }
    return out;
  }

  /** The bytes dropped since last asked. */
  takeSkipped(): Uint8Array {
    const out = Uint8Array.from(this.skipped);
    this.skipped = [];
    return out;
  }
}

/** Bytes in, events out. One per connection: a new one does not carry on the last one's bytes. */
export class DynetStreamDecoder {
  private readonly framer = new DynetFramer();

  feed(data: ArrayLike<number>): DynetEvent[] {
    const out: DynetEvent[] = [];
    for (const packet of this.framer.feed(data)) {
      const skipped = this.framer.takeSkipped();
      if (skipped.length) out.push({ kind: 'skipped', raw: skipped });
      out.push(decode(packet));
    }
    const skipped = this.framer.takeSkipped();
    if (skipped.length) out.push({ kind: 'skipped', raw: skipped });
    return out;
  }
}

/** What one packet (as cut by the framer) says. */
export function decode(packet: Uint8Array): DynetEvent {
  if (packet[0] === SYNC_DYNET2) return decodeDynet2(packet);
  if (packet[0] !== SYNC_LOGICAL) return { kind: 'unknown', packet };
  return decodeDynet1(packet);
}

const FADE_STEP: Record<number, number> = { 0x71: 0.02, 0x72: 0.1, 0x73: 1.0 };

function decodeDynet1(packet: Uint8Array): DynetEvent {
  const area = packet[1];
  const op = packet[3];
  const d1 = packet[2];
  const d2 = packet[4];
  const d3 = packet[5];
  const fade16 = (d1 + d2 * 256) * 0.02;

  if (op <= 0x03 || (op >= 0x0a && op <= 0x0d)) {
    // Eight presets a bank: d3 is the bank, d1/d2 the fade in 0.02 s.
    const index = op <= 0x03 ? op : op - 0x0a + 4;
    return { kind: 'preset', area, preset: d3 * 8 + index + 1, fade: fade16, packet };
  }
  switch (op) {
    case 0x04:
      return { kind: 'off', area, fade: fade16, packet };
    case 0x62:
      return { kind: 'preset', area, preset: d1 + 1, reported: true, packet };
    case 0x65:
      return { kind: 'preset', area, preset: d1 + 1, fade: (d2 + d3 * 256) * 0.02, packet };
    case 0x60:
      return { kind: 'channel', area, channel: d1 + 1, level: dynet1Percent(d2), current: dynet1Percent(d3), reported: true, packet };
    case 0x6b:
      return { kind: 'preset', area, preset: d2 + 1, fade: d3 * 0.02, ...channelOf(d1), packet };
    case 0x76:
      return { kind: 'stop', area, ...channelOf(d1), packet };
    case 0x63:
      return { kind: 'request', area, asks: 'preset', packet };
    case 0x61:
      return { kind: 'request', area, asks: 'level', channel: d1 + 1, packet };
    case 0x49:
      return { kind: 'request', area, asks: 'temperature', packet };
  }
  if (op >= 0x80 && op <= 0x83) {
    // Channels four at a time: d2 is the bank (0xFF for the first four).
    const channel = ((d2 + 1) % 256) * 4 + (op - 0x80) + 1;
    return { kind: 'channel', area, channel, level: dynet1Percent(d1), fade: d3 * 0.02, packet };
  }
  if (op >= 0x71 && op <= 0x73) {
    return { kind: 'channel', area, ...channelOf(d1), level: dynet1Percent(d2), fade: d3 * FADE_STEP[op], packet };
  }
  return { kind: 'unknown', area, packet };
}

/** 0xFF in a DyNet 1 channel byte means every channel in the area. */
function channelOf(d1: number): { channel?: number } {
  return d1 === 0xff ? {} : { channel: d1 + 1 };
}

function decodeDynet2(packet: Uint8Array): DynetEvent {
  const r = packet;
  const cmd = r[2];
  const area = (r[6] << 8) | r[7];
  const channel = (r[10] << 8) | r[11];
  const len = r.length;

  if (cmd === 0x01 && len >= 16) {
    return { kind: 'preset', area, preset: r[10], fade: ((r[11] << 16) | (r[12] << 8) | r[13]) * 0.01, packet };
  }
  if ((cmd === 0x56 || cmd === 0x57) && len >= 16) {
    // Only warm rooms seen so far: how a temperature under 0 is sent is not known.
    const value = r[10] + r[11] / 100;
    if (r[9] === 0x0c) return { kind: 'temperature', area, temperature: value, packet };
    if (r[9] === 0x0d) return { kind: 'setpoint', area, setpoint: value, packet };
  }
  if (cmd === 0x88 && len >= 16) {
    const two = (b: number) => b.toString(16).padStart(2, '0');
    return { kind: 'time', clock: `${two(r[11])}:${two(r[12])}:${two(r[13])}`, packet };
  }
  if (cmd === 0x10 && len >= 20) {
    return { kind: 'channel', area, channel, level: dynet2Percent(r[12]), fade: ((r[14] << 16) | (r[15] << 8) | r[16]) * 0.01, packet };
  }
  if (cmd === 0x20 && len >= 12) return { kind: 'request', area, asks: 'preset', packet };
  if (cmd === 0x22 && len >= 16) return { kind: 'request', area, asks: 'level', channel, packet };
  if (cmd === 0x23 && len >= 20 && r[9] === 2) return { kind: 'preset', area, preset: r[15], reported: true, packet };
  if (cmd === 0x23 && len >= 20 && r[9] === 0) {
    return { kind: 'channel', area, channel, level: dynet2Percent(r[14]), current: dynet2Percent(r[15]), reported: true, packet };
  }
  return { kind: 'unknown', packet };
}

/** One line for a person to read, as Dynalite's own monitor would roughly put it. */
export function describe(event: DynetEvent): string {
  if (event.kind === 'skipped') return `${event.raw.length} byte(s) not DyNet [${hex(event.raw)}]`;
  if (event.kind === 'time') return `time set to ${event.clock}`;
  if (event.kind === 'unknown') {
    const where = event.area !== undefined ? `area ${event.area}: ` : '';
    return `${where}not decoded [${hex(event.packet)}]`;
  }
  let where = `area ${event.area}`;
  if ('channel' in event && event.channel !== undefined) where += ` ch ${event.channel}`;
  const fade = 'fade' in event && event.fade ? ` over ${+event.fade.toFixed(2)} s` : '';
  switch (event.kind) {
    case 'preset':
      return `${where}: ${event.reported ? 'is at' : '→'} preset ${event.preset}${fade}`;
    case 'off':
      return `${where}: off${fade}`;
    case 'channel':
      return event.reported
        ? `${where}: at ${event.current} % (going to ${event.level} %)`
        : `${where}: → ${event.level} %${fade}`;
    case 'stop':
      return `${where}: fade stopped`;
    case 'request':
      return `${where}: ${event.asks} asked`;
    case 'temperature':
      return `${where}: ${event.temperature.toFixed(2)} °C`;
    case 'setpoint':
      return `${where}: set to ${event.setpoint.toFixed(2)} °C`;
  }
}
