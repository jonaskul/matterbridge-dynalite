/**
 * matterbridge-dynalite: Signify Dynalite lights and heating in Matter, straight
 * from the Ethernet gateway.
 */

import type { PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import type { AnsiLogger } from 'matterbridge/logger';

import { DynalitePlatform } from './platform.js';

export { DynalitePlatform } from './platform.js';

export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): DynalitePlatform {
  return new DynalitePlatform(matterbridge, log, config);
}
