/**
 * One gateway: its areas as devices, kept up to date from the bus and from
 * reads, and driven by commands. Knows nothing of Matter — it reports through
 * a DeviceSink and acts through a GatewayApi — so it can be tested on its own.
 */

import { type Area, deviceId, type Gateway } from './config.js';
import { describe, type DynetEvent } from './dynet.js';
import { DynetLive } from './live.js';

/** What the gateway can be asked and told (GatewayHttp, or a stand-in in tests). */
export interface GatewayApi {
  getPreset(area: number): Promise<number | undefined>;
  getLevel(area: number, channel: number): Promise<number | undefined>;
  getTemperature(area: number): Promise<number | undefined>;
  getSetpoint(area: number): Promise<number | undefined>;
  setPreset(area: number, preset: number, fadeMs?: number): Promise<void>;
  setLevel(area: number, channel: number, percent: number, fadeMs?: number): Promise<void>;
  setSetpoint(area: number, setpoint: number): Promise<void>;
}

/** Where state goes: the Matter side, or a recorder in tests. Levels in percent, temperatures in °C. */
export interface DeviceSink {
  light(id: string, state: { on: boolean; level?: number }): void;
  thermostat(id: string, state: { temperature?: number; setpoint?: number }): void;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

export type DeviceKind = 'dimmable' | 'onoff' | 'thermostat';

export interface Device {
  id: string;
  kind: DeviceKind;
  name: string;
  area: number;
  /** The channel, for a channel light; none for an area switched by preset, or a thermostat. */
  channel?: number;
  config: Area;
}

/** After a change on the bus, an area is read back once its fade is done, plus this (ms). */
export const READ_AFTER_MS = 1500;
/** Between areas when reading them all, so the gateway is not swamped (ms). */
export const STAGGER_MS = 500;

const quietLog: Logger = { info: () => undefined, warn: () => undefined, debug: () => undefined };

export class GatewayBridge {
  readonly devices: Device[] = [];
  private readonly byId = new Map<string, Device>();
  private readonly byArea = new Map<number, Device[]>();
  /** The level a channel light was last on at, to go back to when switched on. */
  private readonly lastLevel = new Map<string, number>();
  private readonly reads = new Map<number, NodeJS.Timeout>();
  private pollTimer?: NodeJS.Timeout;
  private live?: DynetLive;
  private stopped = false;

  constructor(
    readonly gateway: Gateway,
    private readonly api: GatewayApi,
    private readonly sink: DeviceSink,
    private readonly log: Logger = quietLog,
    private readonly timing = { readAfterMs: READ_AFTER_MS, staggerMs: STAGGER_MS },
  ) {
    for (const area of gateway.areas) {
      const list: Device[] = [];
      if (area.type === 'thermostat') {
        list.push({ id: deviceId(gateway.name, area.area), kind: 'thermostat', name: area.name, area: area.area, config: area });
      } else if (area.channels.length === 0) {
        list.push({ id: deviceId(gateway.name, area.area), kind: 'onoff', name: area.name, area: area.area, config: area });
      } else {
        for (const c of area.channels) {
          list.push({
            id: deviceId(gateway.name, area.area, c.channel),
            kind: c.dimmable ? 'dimmable' : 'onoff',
            name: c.name,
            area: area.area,
            channel: c.channel,
            config: area,
          });
        }
      }
      this.byArea.set(area.area, list);
      for (const d of list) {
        this.devices.push(d);
        this.byId.set(d.id, d);
      }
    }
  }

  get liveConnected(): boolean {
    return this.live?.connected === true;
  }

  /** Read every area now, then listen to the bus (if a port is set) and read again every pollMinutes. */
  async start(): Promise<void> {
    this.stopped = false;
    const { dynetPort, host } = this.gateway;
    if (dynetPort) {
      this.live = new DynetLive({
        host: host.replace(/:\d+$/, ''), // the HTTP host may carry a port of its own
        port: dynetPort,
        onEvent: (e) => {
          this.log.debug(`${this.gateway.name}: ${describe(e)}`);
          this.handleEvent(e);
        },
        onConnected: (up) => this.log.info(`${this.gateway.name}: DyNet port ${dynetPort} ${up ? 'connected' : 'disconnected'}`),
        onError: (m) => this.log.debug(`${this.gateway.name}: DyNet: ${m}`),
      });
      this.live.start();
    }
    await this.refreshAll();
    const every = this.gateway.pollMinutes * 60_000;
    this.pollTimer = setInterval(() => void this.refreshAll(), every);
  }

  stop(): void {
    this.stopped = true;
    this.live?.stop();
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const t of this.reads.values()) clearTimeout(t);
    this.reads.clear();
  }

  // -- from the bus ------------------------------------------------------------

  handleEvent(event: DynetEvent): void {
    if (!('area' in event) || event.area === undefined) return;
    const devices = this.byArea.get(event.area);
    if (!devices) return; // not an area this bridge shows

    switch (event.kind) {
      case 'temperature':
        for (const d of devices) if (d.kind === 'thermostat') this.sink.thermostat(d.id, { temperature: event.temperature });
        return;
      case 'setpoint':
        for (const d of devices) if (d.kind === 'thermostat') this.sink.thermostat(d.id, { setpoint: event.setpoint });
        return;
      case 'preset':
        for (const d of devices) {
          if (d.kind !== 'thermostat' && d.channel === undefined && event.channel === undefined && d.config.type === 'light') {
            this.sink.light(d.id, { on: event.preset !== d.config.offPreset });
          }
        }
        // Channel lights: what the preset did to their levels is the gateway's to say.
        if (!event.reported && devices.some((d) => d.channel !== undefined)) this.readArea(event.area, event.fade);
        return;
      case 'off':
        for (const d of devices) if (d.kind !== 'thermostat') this.sink.light(d.id, { on: false });
        return;
      case 'channel': {
        const hit = devices.filter((d) => d.channel !== undefined && (event.channel === undefined || d.channel === event.channel));
        const level = event.reported ? (event.current ?? event.level) : event.level;
        for (const d of hit) this.showLevel(d, level);
        // A command (not an answer) fades: read back once it is done, to show where it ended.
        if (!event.reported && hit.length) this.readArea(event.area, event.fade);
        return;
      }
      case 'stop':
        this.readArea(event.area, 0);
        return;
      default:
        return; // questions, the time, what is not known: nothing to show
    }
  }

  // -- reading -----------------------------------------------------------------

  /** Read one area again after *fadeSeconds* (plus a little); a newer change puts it off. */
  readArea(area: number, fadeSeconds = 0): void {
    const pending = this.reads.get(area);
    if (pending) clearTimeout(pending);
    const t = setTimeout(() => {
      this.reads.delete(area);
      void this.refreshArea(area).catch((err: Error) => this.log.warn(`${this.gateway.name}: reading area ${area} failed: ${err.message}`));
    }, (fadeSeconds ?? 0) * 1000 + this.timing.readAfterMs);
    this.reads.set(area, t);
  }

  async refreshAll(): Promise<void> {
    let failed = 0;
    let first = '';
    for (const [i, area] of [...this.byArea.keys()].entries()) {
      if (this.stopped) return;
      if (i > 0 && this.timing.staggerMs > 0) await sleep(this.timing.staggerMs);
      try {
        await this.refreshArea(area);
      } catch (err) {
        failed++;
        first ||= (err as Error).message;
        this.log.debug(`${this.gateway.name}: area ${area}: ${(err as Error).message}`);
      }
    }
    if (failed) {
      const port = /:(\d+)$/.exec(this.gateway.host)?.[1];
      const hint = port && !['80', '443'].includes(port) ? ` Is ${port} the gateway's web server? Its web pages are usually on 80; leave the port out of the address.` : '';
      this.log.warn(`${this.gateway.name}: ${failed} of ${this.byArea.size} areas did not answer (${first}).${hint}`);
    }
  }

  async refreshArea(area: number): Promise<void> {
    for (const d of this.byArea.get(area) ?? []) {
      if (d.kind === 'thermostat') {
        const temperature = await this.api.getTemperature(area);
        const setpoint = await this.api.getSetpoint(area);
        this.sink.thermostat(d.id, { temperature, setpoint });
      } else if (d.channel !== undefined) {
        const level = await this.api.getLevel(area, d.channel);
        if (level !== undefined) this.showLevel(d, level);
      } else if (d.config.type === 'light') {
        const preset = await this.api.getPreset(area);
        if (preset !== undefined) this.sink.light(d.id, { on: preset !== d.config.offPreset });
      }
    }
  }

  private showLevel(d: Device, level: number): void {
    if (level > 0) {
      this.lastLevel.set(d.id, level);
      this.sink.light(d.id, { on: true, level });
    } else {
      this.sink.light(d.id, { on: false });
    }
  }

  // -- commands ----------------------------------------------------------------

  async lightOn(id: string, fadeMs = this.fadeMs): Promise<void> {
    const d = this.device(id, 'light');
    if (d.channel === undefined) {
      if (d.config.type === 'light') await this.api.setPreset(d.area, d.config.onPreset, fadeMs);
    } else {
      await this.api.setLevel(d.area, d.channel, d.kind === 'onoff' ? 100 : (this.lastLevel.get(id) ?? 100), fadeMs);
    }
    this.afterCommand(d, fadeMs);
  }

  async lightOff(id: string, fadeMs = this.fadeMs): Promise<void> {
    const d = this.device(id, 'light');
    if (d.channel === undefined) {
      if (d.config.type === 'light') await this.api.setPreset(d.area, d.config.offPreset, fadeMs);
    } else {
      await this.api.setLevel(d.area, d.channel, 0, fadeMs);
    }
    this.afterCommand(d, fadeMs);
  }

  /** A channel to a level in percent; 0 switches it off. */
  async lightLevel(id: string, percent: number, fadeMs = this.fadeMs): Promise<void> {
    const d = this.device(id, 'light');
    if (d.channel === undefined || d.kind === 'onoff') return percent > 0 ? this.lightOn(id, fadeMs) : this.lightOff(id, fadeMs);
    const level = Math.min(Math.max(percent, 0), 100);
    if (level > 0) this.lastLevel.set(id, level);
    await this.api.setLevel(d.area, d.channel, level, fadeMs);
    this.afterCommand(d, fadeMs);
  }

  /** A thermostat's setpoint, within its limits. Returns what was sent. */
  async setSetpoint(id: string, celsius: number): Promise<number> {
    const d = this.device(id, 'thermostat');
    const cfg = d.config.type === 'thermostat' ? d.config : { minSetpoint: 5, maxSetpoint: 30 };
    const value = Math.round(Math.min(Math.max(celsius, cfg.minSetpoint), cfg.maxSetpoint) * 2) / 2; // half degrees, as panels do
    await this.api.setSetpoint(d.area, value);
    return value;
  }

  private get fadeMs(): number {
    return this.gateway.fadeSeconds * 1000;
  }

  /** With the bus heard, its echo brings the state back; without it, read the area once the fade is done. */
  private afterCommand(d: Device, fadeMs: number): void {
    if (!this.liveConnected) this.readArea(d.area, fadeMs / 1000);
  }

  private device(id: string, want: 'light' | 'thermostat'): Device {
    const d = this.byId.get(id);
    if (!d || (want === 'thermostat') !== (d.kind === 'thermostat')) throw new Error(`No ${want} ${id}`);
    return d;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
