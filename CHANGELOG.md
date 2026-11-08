# Changelog

## 0.2.0 — 2026-11-08

- A settings page of the plugin's own, opened with the globe button by the plugin in Matterbridge's list (in a large dialog, full screen on a phone, or a tab of its own):
  - gateways, areas and channels laid out compactly, each area on one row, with only the fields its type uses;
  - "Test connection" tries the gateway's web pages and its DyNet port before saving, and says when a port connects but has no routes;
  - "Heard on the bus" lists every area the bus has told of since start, with its channels, presets or temperature, to add with a click.
- Setpoints read "setpoint changed to" when changed at the thermostat, and "setpoint" when only told.

## 0.1.2 — 2026-10-15

- Described as "Matterbridge Signify Dynalite plugin", like the other plugins in Matterbridge's list (it is also the log prefix).

## 0.1.1 — 2026-10-15

- The first release published from GitHub, through npm's trusted publishing; the code is as in 0.1.0.

## 0.1.0 — 2026-10-14

First version.

- Lights: each channel as a dimmable or on/off light, or an area as one light switched by its presets.
- Heating: thermostat areas as Matter heating thermostats, with temperature and setpoint.
- Live updates from the gateway's DyNet TCP port (DyNet 1 and DyNet2), with a read-back after fades.
- Commands and reads over the gateway's HTTP API, one request at a time.
- Several gateways; devices identified by gateway name, area and channel.
- Two devices with the same name (a room's light and its thermostat) are told apart, as Matterbridge refuses the second.
