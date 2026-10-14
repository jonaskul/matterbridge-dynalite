# matterbridge-dynalite

A [Matterbridge](https://github.com/Luligu/matterbridge) plugin for **Signify Dynalite** (formerly Philips Dynalite). It puts your Dynalite lights and heating into Apple Home, Google Home, Alexa, SmartThings, Home Assistant or any other Matter controller. The plugin talks straight to the Dynalite Ethernet gateway, with nothing in between.

- **Lights.** Each channel can be its own Matter light: dimmable, or on/off for a relay. An area can also be shown as one light that is switched by its presets.
- **Heating.** A thermostat area becomes a Matter heating thermostat, with the room temperature and a setpoint you can change.
- **Live updates.** With the gateway's DyNet TCP port set up, the plugin reads the bus as it happens. A wall panel press, a timer, a fade, a temperature or a setpoint changed at the thermostat shows in Matter at once. Both DyNet 1 and DyNet2 are read.
- **Commands** use the gateway's own HTTP API, the same one its web pages use. The plugin never writes to the bus directly.
- **Several gateways**, one per site or one per house.

> **Status:** early, but in use. The DyNet2 decoding comes from traffic captured on a PDEG and checked against Dynalite's own monitor (see [docs/DYNET.md](docs/DYNET.md)). Reports from other gateways and installations are very welcome.

## How it works

```
 Matter controller ⇄ Matterbridge ⇄ matterbridge-dynalite ─ HTTP (commands, reads) ─┐
                                                           └─ TCP (DyNet, live) ─────┴─ Dynalite Ethernet gateway ─ DyNet bus
```

- **At start-up,** every configured area is read over HTTP (`GetDyNet.cgi`).
- **With a DyNet port,** the plugin keeps a TCP connection open and decodes every packet. It updates the devices it knows and ignores the rest. When a preset or a fade changes channel levels, it reads the area again once the fade is done, so Matter shows where the lights ended up.
- **Commands** from Matter go to `SetDyNet.cgi`: a channel level with a fade, a preset, or a setpoint.
- **Every area is read again** every *pollMinutes*. With live updates this is a check (60 minutes by default). Without them it is the only source of state (5 minutes by default).

## Requirements

- Matterbridge 3.3.0 or later, on Node.js 20, 22 or 24.
- A Dynalite Ethernet gateway whose web server can be reached from Matterbridge (PDEG, DDNG and similar, with `GetDyNet.cgi` / `SetDyNet.cgi`).
- For live updates, a TCP server port set up on the gateway in its own configuration tool (e.g. System Builder/EnvisionProject): **Mode** Server, **Protocol** TCP, **Connection** *Trunk*, **Port type** DyNet or DyNet2, and a port number, e.g. 50000. A gateway can have several such ports. If another program already listens on one, give this plugin its own.
  - **A new port needs routes.** In the gateway's routing table, route at least *Comm Port 1* (the DyNet bus), *Internal Messages* and the *Web Socket* port **to** the new port. Without them the port connects but sends only its own heartbeat. Copy the routes the gateway's existing trunk port has. No routes **from** the new port are needed: the plugin only listens.

## Installation

Once published on npm, install it from the Matterbridge frontend (*Install plugin* → `matterbridge-dynalite`) or from a shell on the Matterbridge host:

```bash
matterbridge -add matterbridge-dynalite
```

Until then, build it from this repository on the Matterbridge host:

```bash
git clone https://github.com/jonaskul/matterbridge-dynalite.git
cd matterbridge-dynalite
npm install && npm link matterbridge && npm run build
matterbridge -add "$PWD"
```

Restart Matterbridge, open the plugin's settings and add your gateway(s).

## Configuration

Everything is set in the plugin's settings in the Matterbridge frontend, and saved as `matterbridge-dynalite.config.json`:

```json
{
  "name": "matterbridge-dynalite",
  "type": "DynamicPlatform",
  "gateways": [
    {
      "name": "Home",
      "host": "192.168.1.50",
      "dynetPort": 50000,
      "fadeSeconds": 2,
      "areas": [
        { "area": 9, "name": "Stairs", "type": "light", "channels": [{ "channel": 1 }] },
        {
          "area": 10,
          "name": "Kitchen",
          "type": "light",
          "channels": [
            { "channel": 1, "name": "Kitchen ceiling" },
            { "channel": 2, "name": "Kitchen worktop" },
            { "channel": 3, "name": "Kitchen sockets", "dimmable": false }
          ]
        },
        { "area": 24, "name": "Garden", "type": "light", "onPreset": 1, "offPreset": 4 },
        { "area": 18, "name": "Bedroom", "type": "thermostat", "minSetpoint": 10, "maxSetpoint": 25 }
      ]
    }
  ]
}
```

| Gateway setting | | Default |
|---|---|---|
| `name` | Short and unique. It is part of every device's identity, so keep it once set. | |
| `host` | The gateway's IP or host name, with `:port` only if its web server is not on 80/443. Not the DyNet port. | |
| `https`, `allowSelfSigned` | HTTPS, and whether to accept the gateway's self-signed certificate. | off |
| `username`, `password` | Only if the gateway asks for HTTP authentication. | |
| `dynetPort` | The gateway's DyNet TCP port for live updates. Leave it empty to poll only. | none |
| `pollMinutes` | How often every area is read over HTTP. | 60 with live, 5 without |
| `fadeSeconds` | The fade for commands from Matter that don't give one. | 2 |

| Area setting | | Default |
|---|---|---|
| `area` | The DyNet area number (1–65535). | |
| `name` | The name shown in your controller. If a light and a thermostat share a name, the second gets " thermostat" or " light" added. | |
| `type` | `light` or `thermostat`. | `light` |
| `channels` | For lights: `channel`, `name` and `dimmable` (false for a relay). Leave it out to show the area as one light switched by presets. | |
| `onPreset`, `offPreset` | For an area light without channels: the presets that switch it. | 1, 4 |
| `minSetpoint`, `maxSetpoint` | For thermostats: the range offered, °C. Setpoints are sent in half degrees. | 5, 30 |

Matterbridge's usual `whiteList`, `blackList`, `debug` and `unregisterOnShutdown` settings work as in other plugins.

### Finding area and channel numbers

They are in your Dynalite configuration (System Builder or EnvisionProject). You can also watch the bus: with a DyNet port set and `debug` on, the plugin logs what it receives. Press a panel and look for `area N ch M`.

Or watch the port from a shell on the Matterbridge host, without Matterbridge (also a quick check that the port is set up right):

```bash
node /path/to/matterbridge-dynalite/dist/listen.js 192.168.1.50 50000   # add --all for heartbeats and bytes
```

## Notes and limits

- **Setpoints and temperatures** are taken from what the thermostats send. Only temperatures above 0 °C have been seen so far, so how a negative temperature is sent is not known yet.
- **Presets.** Matter has no scenes for bridged lights, so presets aren't exposed as such. An area without channels can be switched on and off through two of them.
- **The gateway answers one HTTP request at a time.** If other software (a dashboard, Home Assistant) also polls it, keep the poll intervals reasonable.

## Development

Matterbridge is linked, not installed. This follows Matterbridge's rule that plugins never depend on it:

```bash
npm install -g matterbridge
npm install
npm link matterbridge
npm run build
npm test
```

The tests cover the DyNet decoding (with packets captured from real gateways), the HTTP client and the TCP connection against local fakes, and the platform inside a real matter.js server with Matterbridge's test harness.

To try a local build in Matterbridge, run `matterbridge -add /path/to/matterbridge-dynalite` and restart it.

### Releasing

1. Set the new version in `package.json` (and in `CHANGELOG.md`), and push it.
2. Make a GitHub release with the tag `v<version>`, e.g. `v0.1.0`.

The *Publish* workflow then tests it and publishes it to npm with provenance, through npm's trusted publishing (no token in the repository). A release marked as a pre-release goes out under the `next` tag, so Matterbridge keeps offering the last full release.

## Licence

Apache-2.0. Dynalite, DyNet, Signify and Philips are trademarks of their respective owners. This project is not affiliated with or endorsed by Signify.
