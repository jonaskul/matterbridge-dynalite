/**
 * The gateway's HTTP API (GetDyNet.cgi / SetDyNet.cgi): commands, and reading
 * an area's state when the bus has not told it.
 *
 * The gateway answers one request at a time and is slow when busy, so requests
 * are queued and sent one after another. A read that times out is tried once
 * more; a command is not, since it may have gone through.
 */

import http from 'node:http';
import https from 'node:https';

export interface GatewayHttpOptions {
  host: string;
  /** Use HTTPS. */
  https?: boolean;
  /** Accept a self-signed certificate (HTTPS only). */
  allowSelfSigned?: boolean;
  /** HTTP Basic authentication, if the gateway is set to ask for it. */
  username?: string;
  password?: string;
  /** Milliseconds before a request counts as not answered. */
  timeoutMs?: number;
}

export class GatewayError extends Error {}
/** The gateway could not be reached at all. */
export class GatewayUnreachableError extends GatewayError {}
/** The gateway took the request but did not answer in time. */
export class GatewayTimeoutError extends GatewayError {}

/** The gateway answers lines of key=value, or "." for nothing. */
export function parseAnswer(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (text.trim() === '.') return out;
  for (const line of text.trim().split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** The query string as the gateway wants it: a '+' encoded as %2B is not understood, so no sign is ever sent. */
export function queryString(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

function number(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export class GatewayHttp {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly timeoutMs: number;

  constructor(private readonly options: GatewayHttpOptions) {
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  // -- reads -----------------------------------------------------------------

  /** The preset an area is at (1-based), if it says. */
  async getPreset(area: number): Promise<number | undefined> {
    return number((await this.read({ a: area, p: '' })).p);
  }

  /** A channel's level, in percent. */
  async getLevel(area: number, channel: number): Promise<number | undefined> {
    return number((await this.read({ a: area, c: channel, j: 255 })).l);
  }

  /** A thermostat's temperature, °C. */
  async getTemperature(area: number): Promise<number | undefined> {
    return number((await this.read({ a: area, tptr: 1, j: 255 })).t);
  }

  /** A thermostat's setpoint, °C. */
  async getSetpoint(area: number): Promise<number | undefined> {
    return number((await this.read({ a: area, tpsp: 1, j: 255 })).t);
  }

  // -- commands --------------------------------------------------------------

  async setPreset(area: number, preset: number, fadeMs = 1000): Promise<void> {
    await this.command({ a: area, p: preset, f: Math.round(fadeMs), j: 255 });
  }

  /** A channel to a level in percent (0–100). */
  async setLevel(area: number, channel: number, percent: number, fadeMs = 500): Promise<void> {
    const level = Math.round(Math.min(Math.max(percent, 0), 100));
    await this.command({ a: area, c: channel, l: level, f: Math.round(fadeMs), j: 255 });
  }

  /** A thermostat's setpoint, °C. */
  async setSetpoint(area: number, setpoint: number): Promise<void> {
    await this.command({ a: area, tpsp: setpoint.toFixed(2), j: 255 });
  }

  // -- plumbing --------------------------------------------------------------

  private async read(params: Record<string, string | number>): Promise<Record<string, string>> {
    try {
      return await this.get('GetDyNet.cgi', params);
    } catch (err) {
      if (err instanceof GatewayTimeoutError) return this.get('GetDyNet.cgi', params); // a busy gateway; once more
      throw err;
    }
  }

  private command(params: Record<string, string | number>): Promise<Record<string, string>> {
    return this.get('SetDyNet.cgi', params);
  }

  /** One request, after any before it. */
  private get(endpoint: string, params: Record<string, string | number>): Promise<Record<string, string>> {
    const run = () => this.request(endpoint, params);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private request(endpoint: string, params: Record<string, string | number>): Promise<Record<string, string>> {
    const { host, username, password } = this.options;
    const secure = this.options.https === true;
    const lib = secure ? https : http;
    const headers: Record<string, string> = {};
    if (username) headers.Authorization = `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`;

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };
      const req = lib.request(
        `${secure ? 'https' : 'http'}://${host}/${endpoint}?${queryString(params)}`,
        {
          method: 'GET',
          headers,
          timeout: this.timeoutMs,
          ...(secure ? { rejectUnauthorized: this.options.allowSelfSigned !== true } : {}),
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () =>
            done(() => {
              const status = res.statusCode ?? 0;
              if (status < 200 || status >= 300) reject(new GatewayError(`${endpoint} answered HTTP ${status}`));
              else resolve(parseAnswer(body));
            }),
          );
          res.on('error', (err) => done(() => reject(new GatewayTimeoutError(`${endpoint}: ${err.message}`))));
        },
      );
      req.on('timeout', () => {
        req.destroy();
        done(() => reject(new GatewayTimeoutError(`${endpoint}: no answer in ${this.timeoutMs} ms`)));
      });
      req.on('error', (err: NodeJS.ErrnoException) =>
        done(() => {
          const unreachable = ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN'].includes(err.code ?? '');
          reject(unreachable ? new GatewayUnreachableError(`Cannot reach ${host}: ${err.message}`) : new GatewayTimeoutError(`${endpoint}: ${err.message}`));
        }),
      );
      req.end();
    });
  }
}
