/**
 * The plugin's configuration, as set in Matterbridge's frontend, read into a
 * shape the rest can trust: every gateway named once, every area a number, and
 * a list of what was wrong rather than an exception.
 */

export interface ChannelConfig {
  /** The DyNet channel number in the area (1–255). */
  channel: number;
  /** The name shown in the controller; the area's name and the channel number if left out. */
  name?: string;
  /** A dimmer (true, the default) or a relay that only switches. */
  dimmable?: boolean;
}

export interface AreaConfig {
  /** The DyNet area number (1–65535). */
  area: number;
  name: string;
  /** A light (channels, or the area as one switch through its presets) or a thermostat. */
  type: 'light' | 'thermostat';
  /** Light: each channel its own Matter light. Left out, the area is one light switched by preset. */
  channels?: ChannelConfig[];
  /** Light without channels: the preset that turns it on (1 by default). */
  onPreset?: number;
  /** Light without channels: the preset that turns it off (4 by default, Dynalite's usual Off). */
  offPreset?: number;
  /** Thermostat: the lowest and highest setpoint offered, °C. */
  minSetpoint?: number;
  maxSetpoint?: number;
}

export interface GatewayConfig {
  /** A short name, unique among the gateways; it is part of every device's identity, so keep it once set. */
  name: string;
  /** The gateway's address, as reached by HTTP (an IP or a host name, with :port if not 80/443). */
  host: string;
  https?: boolean;
  allowSelfSigned?: boolean;
  username?: string;
  password?: string;
  /** The gateway's raw DyNet TCP server port for live updates (DyNet 1 or DyNet2, connection Trunk); 0 or empty for none. */
  dynetPort?: number;
  /** Minutes between reading every area over HTTP: a check when live, the only source otherwise. */
  pollMinutes?: number;
  /** The fade for commands from Matter that do not give one, seconds. */
  fadeSeconds?: number;
  areas: AreaConfig[];
}

export interface PluginConfig {
  gateways: GatewayConfig[];
}

/** Defaults filled in. */
export interface Gateway extends Required<Omit<GatewayConfig, 'username' | 'password' | 'areas'>> {
  username: string;
  password: string;
  areas: Area[];
}

export type Area =
  | { area: number; name: string; type: 'light'; channels: Required<ChannelConfig>[]; onPreset: number; offPreset: number }
  | { area: number; name: string; type: 'thermostat'; minSetpoint: number; maxSetpoint: number };

export const DEFAULT_POLL_LIVE = 60;
export const DEFAULT_POLL_NO_LIVE = 5;

function int(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Reads the raw configuration; what cannot be used is left out and said in `problems`. */
export function readConfig(raw: unknown): { gateways: Gateway[]; problems: string[] } {
  const problems: string[] = [];
  const gateways: Gateway[] = [];
  const list = (raw as { gateways?: unknown })?.gateways;
  if (!Array.isArray(list) || list.length === 0) {
    return { gateways, problems: ['No gateways configured: add one in the plugin settings.'] };
  }
  const names = new Set<string>();

  list.forEach((g: Record<string, unknown>, gi) => {
    const name = text(g?.name) || `gateway${gi + 1}`;
    const host = text(g?.host);
    if (!host) {
      problems.push(`Gateway "${name}": no host — left out.`);
      return;
    }
    if (names.has(name.toLowerCase())) {
      problems.push(`Gateway "${name}": the name is used twice — left out.`);
      return;
    }
    names.add(name.toLowerCase());
    const dynetPort = int(g.dynetPort, 1, 65535) ?? 0;

    const areas: Area[] = [];
    const seen = new Set<number>();
    (Array.isArray(g.areas) ? g.areas : []).forEach((a: Record<string, unknown>, ai) => {
      const area = int(a?.area, 1, 65535);
      const label = text(a?.name) || (area !== undefined ? `Area ${area}` : `#${ai + 1}`);
      if (area === undefined) {
        problems.push(`Gateway "${name}", area "${label}": no valid area number (1–65535) — left out.`);
        return;
      }
      if (seen.has(area)) {
        problems.push(`Gateway "${name}": area ${area} is listed twice — the second is left out.`);
        return;
      }
      seen.add(area);
      if (a.type === 'thermostat') {
        const minSetpoint = num(a.minSetpoint, 5, 0, 40);
        const maxSetpoint = num(a.maxSetpoint, 30, minSetpoint, 40);
        areas.push({ area, name: label, type: 'thermostat', minSetpoint, maxSetpoint });
        return;
      }
      if (a.type !== undefined && a.type !== 'light') {
        problems.push(`Gateway "${name}", area ${area}: type "${String(a.type)}" is not known; taken as a light.`);
      }
      const channels: Required<ChannelConfig>[] = [];
      const chans = new Set<number>();
      (Array.isArray(a.channels) ? a.channels : []).forEach((c: Record<string, unknown>) => {
        const channel = int(c?.channel ?? c, 1, 255);
        if (channel === undefined || chans.has(channel)) {
          problems.push(`Gateway "${name}", area ${area}: a channel is not a number 1–255 or is listed twice — left out.`);
          return;
        }
        chans.add(channel);
        channels.push({ channel, name: text(c?.name) || `${label} ${channel}`, dimmable: c?.dimmable !== false });
      });
      areas.push({
        area,
        name: label,
        type: 'light',
        channels,
        onPreset: int(a.onPreset, 1, 65535) ?? 1,
        offPreset: int(a.offPreset, 1, 65535) ?? 4,
      });
    });
    if (areas.length === 0) problems.push(`Gateway "${name}": no areas — nothing to show in Matter.`);

    gateways.push({
      name,
      host,
      https: g.https === true,
      allowSelfSigned: g.allowSelfSigned === true,
      username: text(g.username),
      password: typeof g.password === 'string' ? g.password : '',
      dynetPort,
      pollMinutes: num(g.pollMinutes, dynetPort ? DEFAULT_POLL_LIVE : DEFAULT_POLL_NO_LIVE, 1, 24 * 60),
      fadeSeconds: num(g.fadeSeconds, 2, 0, 600),
      areas,
    });
  });
  return { gateways, problems };
}

/** A device's stable identity: the gateway's name, the area and (for a channel) the channel. */
export function deviceId(gateway: string, area: number, channel?: number): string {
  const slug = gateway.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'gw';
  return channel === undefined ? `dynalite-${slug}-a${area}` : `dynalite-${slug}-a${area}-c${channel}`;
}
