/**
 * The Matterbridge side: each configured gateway's areas as Matter devices.
 *
 * A channel becomes a dimmable light (or an on/off light for a relay), an area
 * with no channels listed one light switched through its presets, and a
 * thermostat area a heating thermostat. Commands go to the gateway over HTTP;
 * state comes back from the bus as it happens (when a DyNet port is set) and
 * from reading the areas now and then.
 */

import {
  dimmableLight,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  onOffLight,
  type PlatformConfig,
  type PlatformMatterbridge,
  thermostat as thermostatDeviceType,
} from 'matterbridge';
import type { AnsiLogger } from 'matterbridge/logger';

import { type Device, GatewayBridge } from './bridge.js';
import { readConfig } from './config.js';
import { GatewayHttp } from './gateway.js';

/** Matter levels run 1–254; DynaDash and the gateway speak percent. */
export function percentToLevel(percent: number): number {
  return Math.min(254, Math.max(1, Math.round((percent * 254) / 100)));
}

export function levelToPercent(level: number): number {
  return Math.round((level / 254) * 1000) / 10;
}

/** A Matter transition time (tenths of a second, or null) as milliseconds; undefined to use the gateway's default fade. */
function fadeOf(transitionTime: number | null | undefined): number | undefined {
  return typeof transitionTime === 'number' ? transitionTime * 100 : undefined;
}

/** Matterbridge refuses a second device with the same name: a light and a thermostat both called after their room are told apart. */
export function uniqueName(device: Device, taken: Set<string>): string {
  const base = device.name;
  const candidates = [base, device.kind === 'thermostat' ? `${base} thermostat` : `${base} light`];
  let name = candidates.find((c) => !taken.has(c.toLowerCase()));
  for (let i = 2; !name; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) name = `${base} ${i}`;
  taken.add(name.toLowerCase());
  return name;
}

export class DynalitePlatform extends MatterbridgeDynamicPlatform {
  private readonly bridges: GatewayBridge[] = [];
  private readonly endpoints = new Map<string, MatterbridgeEndpoint>();
  /** The setpoint each thermostat last showed from the gateway, so its own echo is not sent back. */
  private readonly setpointFromGateway = new Map<string, number>();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);
    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.3.0')) {
      throw new Error(
        `This plugin requires Matterbridge 3.3.0 or later; this is ${this.matterbridge.matterbridgeVersion}. Update Matterbridge in its frontend.`,
      );
    }
    this.log.info('Initializing Dynalite platform');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`Starting (${reason ?? 'no reason given'})`);
    await this.ready;
    await this.clearSelect();

    const { gateways, problems } = readConfig(this.config);
    for (const p of problems) this.log.warn(p);
    const names = new Set<string>();

    for (const gw of gateways) {
      const api = new GatewayHttp({
        host: gw.host,
        https: gw.https,
        allowSelfSigned: gw.allowSelfSigned,
        username: gw.username,
        password: gw.password,
      });
      const bridge = new GatewayBridge(
        gw,
        api,
        {
          light: (id, state) => void this.showLight(id, state),
          thermostat: (id, state) => void this.showThermostat(id, state),
        },
        { info: (m) => this.log.info(m), warn: (m) => this.log.warn(m), debug: (m) => this.log.debug(m) },
      );
      this.bridges.push(bridge);
      for (const device of bridge.devices) {
        const name = uniqueName(device, names);
        if (name !== device.name) {
          this.log.info(`${device.name} (area ${device.area}${device.channel !== undefined ? ` ch ${device.channel}` : ''}): the name is taken, shown as "${name}"`);
          device.name = name;
        }
        if (!this.validateDevice([device.name, device.id])) continue;
        const endpoint = this.createEndpoint(bridge, device);
        this.setSelectDevice(device.id, device.name, undefined, device.kind === 'thermostat' ? 'hub' : 'wifi');
        await this.registerDevice(endpoint);
        this.endpoints.set(device.id, endpoint);
      }
      this.log.info(`${gw.name} (${gw.host}): ${bridge.devices.length} device(s)${gw.dynetPort ? `, live on port ${gw.dynetPort}` : ', no live port: polled'}`);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    // Not awaited: a gateway that is slow to answer must not hold Matterbridge up.
    for (const bridge of this.bridges) {
      bridge.start().catch((err: Error) => this.log.error(`${bridge.gateway.name}: ${err.message}`));
    }
  }

  override async onShutdown(reason?: string): Promise<void> {
    for (const bridge of this.bridges) bridge.stop();
    await super.onShutdown(reason);
    this.log.info(`Shut down (${reason ?? 'no reason given'})`);
    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  // -- devices -----------------------------------------------------------------

  private createEndpoint(bridge: GatewayBridge, device: Device): MatterbridgeEndpoint {
    const model = device.kind === 'thermostat' ? 'Dynalite thermostat' : device.channel !== undefined ? 'Dynalite channel' : 'Dynalite area';
    const deviceType = device.kind === 'thermostat' ? thermostatDeviceType : device.kind === 'dimmable' ? dimmableLight : onOffLight;
    const endpoint = new MatterbridgeEndpoint(deviceType, { id: device.id }, this.config.debug === true).createDefaultBridgedDeviceBasicInformationClusterServer(
      device.name,
      device.id,
      this.matterbridge.aggregatorVendorId,
      'Signify Dynalite',
      model,
    );
    const fail = (what: string) => (err: Error) => this.log.error(`${device.name}: ${what} failed: ${err.message}`);

    if (device.kind === 'thermostat') {
      const cfg = device.config.type === 'thermostat' ? device.config : { minSetpoint: 5, maxSetpoint: 30 };
      endpoint
        .createDefaultIdentifyClusterServer()
        .createDefaultHeatingThermostatClusterServer(20, 20, cfg.minSetpoint, cfg.maxSetpoint)
        .addRequiredClusterServers();
      // A controller sets the setpoint by writing it.
      endpoint.subscribeAttribute(
        'thermostat',
        'occupiedHeatingSetpoint',
        (value: number, _old: number, context: { offline?: boolean } | undefined) => {
          if (context?.offline === true || typeof value !== 'number') return; // our own update
          const celsius = value / 100;
          if (Math.abs((this.setpointFromGateway.get(device.id) ?? NaN) - celsius) < 0.005) return; // the gateway's own value
          this.log.info(`${device.name}: setpoint → ${celsius} °C`);
          bridge
            .setSetpoint(device.id, celsius)
            .then((sent) => this.setpointFromGateway.set(device.id, sent))
            .catch(fail('setting the setpoint'));
        },
        this.log,
      );
      endpoint.addCommandHandler('setpointRaiseLower', async ({ request }) => {
        const current = this.setpointFromGateway.get(device.id) ?? (endpoint.getAttribute('thermostat', 'occupiedHeatingSetpoint') as number) / 100;
        const sent = await bridge.setSetpoint(device.id, current + request.amount / 10);
        this.setpointFromGateway.set(device.id, sent);
        await endpoint.updateAttribute('thermostat', 'occupiedHeatingSetpoint', Math.round(sent * 100), this.log);
      });
      return endpoint;
    }

    endpoint.addRequiredClusterServers();
    endpoint.addCommandHandler('on', async () => bridge.lightOn(device.id).catch(fail('switching on')));
    endpoint.addCommandHandler('off', async () => bridge.lightOff(device.id).catch(fail('switching off')));
    endpoint.addCommandHandler('toggle', async () => {
      // Called before the toggle takes effect: the attribute still says what it was.
      const wasOn = endpoint.getAttribute('onOff', 'onOff') === true;
      await (wasOn ? bridge.lightOff(device.id) : bridge.lightOn(device.id)).catch(fail('toggling'));
    });
    if (device.kind === 'dimmable') {
      endpoint.addCommandHandler('moveToLevel', async ({ request }) => {
        // Without OnOff a level change leaves an off light off: remembered for when it is switched on.
        if (endpoint.getAttribute('onOff', 'onOff') !== true) return;
        await bridge.lightLevel(device.id, levelToPercent(request.level), fadeOf(request.transitionTime)).catch(fail('dimming'));
      });
      endpoint.addCommandHandler('moveToLevelWithOnOff', async ({ request }) => {
        await bridge.lightLevel(device.id, levelToPercent(request.level), fadeOf(request.transitionTime)).catch(fail('dimming'));
      });
    }
    return endpoint;
  }

  // -- state from the gateway --------------------------------------------------

  private async showLight(id: string, state: { on: boolean; level?: number }): Promise<void> {
    const endpoint = this.endpoints.get(id);
    if (!endpoint) return;
    try {
      await endpoint.updateAttribute('onOff', 'onOff', state.on, this.log);
      if (state.on && state.level !== undefined && endpoint.hasClusterServer('levelControl')) {
        await endpoint.updateAttribute('levelControl', 'currentLevel', percentToLevel(state.level), this.log);
      }
    } catch (err) {
      this.log.debug(`${id}: ${(err as Error).message}`);
    }
  }

  private async showThermostat(id: string, state: { temperature?: number; setpoint?: number }): Promise<void> {
    const endpoint = this.endpoints.get(id);
    if (!endpoint) return;
    try {
      if (state.temperature !== undefined) {
        await endpoint.updateAttribute('thermostat', 'localTemperature', Math.round(state.temperature * 100), this.log);
      }
      if (state.setpoint !== undefined) {
        this.setpointFromGateway.set(id, state.setpoint);
        await endpoint.updateAttribute('thermostat', 'occupiedHeatingSetpoint', Math.round(state.setpoint * 100), this.log);
      }
    } catch (err) {
      this.log.debug(`${id}: ${(err as Error).message}`);
    }
  }
}
