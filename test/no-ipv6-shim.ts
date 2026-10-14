/**
 * Test-only: on a machine without IPv6 (some containers), matter.js cannot open
 * its mDNS socket and no Matter server starts. There, IPv6 UDP sockets are
 * opened as IPv4 instead, and IPv6 multicast membership is skipped. Where IPv6
 * works (CI runners, real machines) this does nothing.
 */

import dgram from 'node:dgram';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

function hasIpv6(): boolean {
  try {
    execFileSync(process.execPath, ['-e', "require('dgram').createSocket('udp6').bind(0,'::',()=>process.exit(0)).on('error',()=>process.exit(1))"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

if (!hasIpv6()) {
  const create = dgram.createSocket;
  (dgram as { createSocket: typeof dgram.createSocket }).createSocket = ((type: dgram.SocketType | dgram.SocketOptions, listener?: never) => {
    const opts = typeof type === 'string' ? { type } : { ...type };
    const v6 = opts.type === 'udp6';
    const { ipv6Only: _ipv6Only, ...rest } = opts as dgram.SocketOptions;
    const socket = create({ ...rest, type: 'udp4' } as dgram.SocketOptions, listener);
    if (v6) {
      const bind = socket.bind.bind(socket) as (...a: unknown[]) => dgram.Socket;
      (socket as unknown as { bind: (...a: unknown[]) => dgram.Socket }).bind = (...args: unknown[]) => {
        if (typeof args[0] === 'object' && args[0] !== null) args[0] = { ...(args[0] as object), address: '0.0.0.0' };
        else if (typeof args[1] === 'string') args[1] = '0.0.0.0';
        return bind(...args);
      };
      socket.addMembership = () => undefined;
      socket.setMulticastInterface = () => undefined;
    }
    return socket;
  }) as typeof dgram.createSocket;
  syncBuiltinESMExports(); // so that `import * as dgram` elsewhere sees it too
}
