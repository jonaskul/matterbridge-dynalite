# DyNet as read off an Ethernet gateway

These are notes on the packets the plugin reads from a Dynalite Ethernet gateway's raw TCP port (Mode Server, Connection *Trunk*). They come from packets captured on a real installation (a PDEG with a DyNet2 port). Each was checked either against Dynalite's own monitor reading the same packets, or against the traffic around commands whose values were known. The tests in [`test/dynet.test.ts`](../test/dynet.test.ts) use those captured packets.

The two protocols arrive side by side on the same stream. A connection may start halfway through a packet, so the decoder resynchronises on a sync byte and a valid checksum.

## DyNet 1: eight bytes

```
sync  area  d1  opcode  d2  d3  join  checksum
```

- **sync:** `1C` logical (area) message, `5C` device message, `6C` debug.
- **checksum:** makes the eight bytes add up to 0 (mod 256).
- **levels:** upside down, `01` is 100 % and `FF` is 0 %.

| Opcode | Meaning |
|---|---|
| `00`–`03`, `0A`–`0D` | Select preset 1–8 in bank `d3`; fade `d1 + 256·d2` × 0.02 s |
| `04` | Off; fade as above |
| `60` | Report channel level: channel `d1+1`, target `d2`, current `d3` |
| `61` | Request channel level |
| `62` | Report preset `d1+1` |
| `63` | Request preset |
| `65` | Linear preset `d1+1`; fade `d2 + 256·d3` × 0.02 s |
| `6B` | Fade channel `d1+1` (`FF` = all) to preset `d2+1` |
| `71`/`72`/`73` | Fade channel `d1+1` (`FF` = all) to level `d2`, over `d3` × 0.02 / 0.1 / 1 s |
| `76` | Stop fading, channel `d1+1` (`FF` = all) |
| `80`–`83` | Set channel (bank `d2`, `FF` = 1–4) to level `d1`, fade `d3` × 0.02 s |

## DyNet2: variable length

```
AC  len  cmd  …  checksum(2)
```

- **length:** 4 bytes of head and `len` × 4 bytes after it, so the whole packet is `4 + 4·len` bytes.
- **checksum:** the last two bytes are a Fletcher-16 of everything before them. The running sum of the sums comes first, then the plain sum (each mod 256).
- **area messages:** a 16-bit area at bytes 6–7 (big-endian) and a join at byte 8.

### Checked against Dynalite's monitor

| Cmd | Meaning | Layout |
|---|---|---|
| `01` | Area selects a preset | preset (1-based) at 10; fade at 11–13, in hundredths of a second |
| `57` | Thermostat reply (*Reply with Actual temperature* for `0C`) | byte 9 names the value: `0C` temperature, `0D` setpoint; whole °C at 10, hundredths at 11 |
| `56` | The same, sent as the setpoint is changed at the thermostat | as `57` |
| `88` | Set device time | hh mm ss at 11–13, BCD |

Byte 9, not the command, decides whether a value is a temperature or a setpoint. A `57` reply can carry a setpoint (`0D`). Reading every `57` as a temperature once put a room's setpoint into its temperature history.

### Read from traffic around known commands

| Cmd | Meaning | Layout |
|---|---|---|
| `10` | Channel set to a level | channel at 10–11; level at 12 (0–254, 254 = 100 %); fade at 14–16, hundredths |
| `20` | "Which preset is the area at?" | |
| `22` | "Which level is the channel at?" | channel at 10–11 |
| `55` | "What is the thermostat's value?" — answered by `57` | byte 9 as in `57`: `0C` temperature, `0D` setpoint |
| `23` | Answer to `20`/`22` | byte 9: `02` preset (value at 15), `00` channel (channel at 10–11, current level at 14, target at 15) |

These were seen when 30 % and 75 % were set on a channel: the levels went over as `4C` (76) and `BE` (190). The gateway's own read-back followed.

In a `23` answer, byte 14 is the level now and 15 the level it is fading to: asked 50 ms into a 2 s fade from 4.7 % to 9.8 %, the answer had `0C` (4.7 %) at 14 and `19` (9.8 %) at 15. That is the other way round from DyNet 1's `60`.

### Seen, not understood

| Cmd | Seen as |
|---|---|
| `82` | `AC 04 82 C3 00 46 AA 55 55 00 0C 00 …`, about every three seconds: likely a heartbeat from the gateway |

Not yet seen: a temperature below 0 °C. If you capture one, or any other packet not listed here, please open an issue with the bytes and what was done at the time.
