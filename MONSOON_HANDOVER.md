# Monsoon — Claude Code Handover

## Project Overview

Monsoon is a Raspberry Pi-based automated terrace irrigation system. The Pi (`monsoon`, `192.168.3.70`) acts as a thin relay agent controlling peristaltic pumps via Sequent SSR HATs over I2C. The dashboard and broader infrastructure run on a separate Debian deploy server (`downpour`, `192.168.3.50`).

---

## Network

| Host | IP | Role |
|------|----|------|
| downpour | 192.168.3.50 | Debian deploy server — dashboard, zigbee2mqtt, PM2 |
| monsoon | 192.168.3.70 | Raspberry Pi 3B+ — relay agent, HATs |
| Router/GW | 192.168.3.1 | Gateway |
| DNS | 192.168.3.40 | Pi-hole |

---

## Hardware — monsoon (192.168.3.70)

- **Board**: Raspberry Pi 3B+
- **OS**: Raspberry Pi OS Trixie (Debian testing), NetworkManager
- **WiFi**: static IP `192.168.3.70` via nmcli, connection name `netplan-wlan0-Inner Womb`
- **HAT stack** (bottom to top):
  - **Raspberry Pi 3B+**
  - **Multichemistry Watchdog HAT** (SKU SM-I-033) — I2C `0x30`, repo `wdt-rpi`
  - **Sixteen SSR HAT** (SKU SM-I-023) — I2C `0x20`, repo `16relind-rpi`, DIP all OFF (board_index 0)
- **I2C**: enabled, `/dev/i2c-1` and `/dev/i2c-2` present
- **Power**: flows through Watchdog HAT — do not power Pi directly via USB-C

---

## Software — monsoon

### Relay Agent

- **Location**: `/opt/monsoon/`
- **Entry point**: `server.js`
- **Config**: `config.js`
- **Service**: `/etc/systemd/system/monsoon.service`, runs as `root`
- **Mode**: `MONSOON_DUMMY=0` in the service env (live mode, HATs active)
- **Port**: `80` (default) or via `MONSOON_PORT` env var
- **Calibration file**: `pumps.json` (auto-created at `/opt/monsoon/pumps.json` on first pump update, not committed to git)

#### Service file

```ini
[Unit]
Description=Monsoon Relay Agent
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/monsoon/server.js
WorkingDirectory=/opt/monsoon
Restart=always
RestartSec=5
User=root
Environment=NODE_ENV=production MONSOON_DUMMY=0

[Install]
WantedBy=multi-user.target
```

#### config.js highlights (current state)

```js
// HAT layout — edit here to add more HATs
HATS = [
  { address: 0x20, board_index: 0, pump_count: 14 },
  // { address: 0x21, board_index: 1, pump_count: 16 },
]

// Auto-generated from HATS — do not edit manually
PUMPS = 14 pumps, ids 0–13, each with:
  { id, board_index, channel, name, enabled, flow_ml_per_s }

TOTAL_CHANNELS = PUMPS.length           // 14 currently
MAX_PUMP_DURATION_MS = 600_000          // 10 min hard cap
MIN_COOLDOWN_MS = 5_000                 // 5s between activations
DUMMY_MODE_DEFAULT = false              // set true to test without hardware
  // env override: MONSOON_DUMMY=0 → live, MONSOON_DUMMY=1 → dummy, unset → DUMMY_MODE_DEFAULT
```

---

## Session Changes (2026-04-02)

The following changes were made in this session. The client (downpour) must be updated to match.

### 1. HAT-based configuration

`RELAY_BOARD_ADDRESSES`, `TOTAL_CHANNELS` (hardcoded 16), and `MONSOON_BOARD_INDEX` are **gone**. The new source of truth is the `HATS` array in `config.js`. Adding a second HAT is a one-line change there — no other files need editing.

Pump IDs are now a flat global sequence `0..N-1` derived from the HATS config. The client never needs to reference HATs, board indices, or local channels — those are internal routing details.

### 2. New endpoint: GET /pumps/available

Call this once at startup to discover how many pumps exist.

```json
GET /pumps/available

{
  "ok": true,
  "total_pumps": 14,
  "enabled_pumps": 14,
  "hats": [
    { "address": "0x20", "board_index": 0, "pump_count": 14 }
  ]
}
```

The client should use `total_pumps` (not a hardcoded 14) for building pump lists, loops, and UI grids. `hats` is informational — the client can ignore it.

### 3. Pump calibration persisted to pumps.json

Any `PUT /pumps/:id` (name, enabled, flow_ml_per_s) is now immediately written to `pumps.json` next to `server.js`. On restart, calibration is restored automatically. The client can update calibration at any time and it will survive service restarts — no manual config editing required on the Pi.

### 4. Dummy mode default is now explicit in config.js

`DUMMY_MODE_DEFAULT = false` in `config.js`. The service env (`MONSOON_DUMMY=0`) still takes precedence. The client can check `dummy_mode` in `GET /health` to know which mode is active.

### 5. GET /pumps response now includes board_index and channel

```json
{ "id": 0, "board_index": 0, "channel": 0, "name": "pump-00", "enabled": true, "flow_ml_per_s": 1.0 }
```

The client should use `id` for all pump operations. `board_index` and `channel` are hardware details — safe to display in a debug view but not needed for normal operation.

---

## Client Integration Guide (for downpour)

### Startup sequence

```
1. GET /pumps/available         → learn total_pumps count
2. GET /pumps                   → load full pump list (names, calibration, enabled)
3. GET /health                  → confirm dummy_mode, uptime
4. GET /watchdog/battery        → initial battery level
```

### Dispensing water

```
POST /relay/:pump_id/dispense   { "ml": 25 }
```

Use the pump's calibrated `flow_ml_per_s` (from GET /pumps) to estimate duration on the client side for progress display, but let the agent calculate the actual timing.

### Watering sequence (multiple pumps)

```
POST /sequence/start
{
  "steps": [
    { "pump_id": 0, "ml": 25 },
    { "pump_id": 3, "ml": 30 }
  ]
}
```

Poll `GET /sequence/status` for progress. Steps run serially with automatic cooldown gaps.

### Calibrating a pump

```
PUT /pumps/0   { "flow_ml_per_s": 1.35 }
```

Calibration is immediately saved to `pumps.json` — no restart needed.

### Emergency stop

```
POST /emergency-stop   { "reason": "operator override" }
```

Aborts any running sequence and cuts all relays hardware-level.

---

## Watchdog Script

- **Location**: `/usr/local/sbin/monsoon-watchdog.sh`
- **Cron**: `* * * * *` (root crontab, every minute)
- **Purpose**: feeds hardware watchdog via `wdt -r`; initiates clean shutdown if battery drops below threshold
- **Threshold**: `BATTERY_MIN_MV=3600` — consider raising to 3700–3800 for safer shutdown margin
- **Battery at last check**: ~3638–3678mV (low, needs charging before deployment)

#### Key wdt commands

```bash
wdt -r              # feed watchdog (reset timer)
wdt -g vb           # get battery voltage in mV (returns plain integer)
wdt -rob 0          # disable restart on battery
wdt -p <seconds>    # set watchdog period
wdt -poff           # power off without restart (use before hardware work)
```

#### Known issue in watchdog script

`set -euo pipefail` will exit immediately if `wdt -g vb` fails. This means the watchdog never gets fed on an I2C error. Recommend adding a fallback:

```bash
battery_mv=$("$WDT_BIN" -g vb 2>/dev/null) || {
    log "WARN could not read battery voltage, resetting watchdog anyway"
    "$WDT_BIN" -r
    exit 0
}
```

---

## Infrastructure — downpour (192.168.3.50)

Downpour runs the dashboard (not yet built) and zigbee2mqtt. It uses PM2 under `pm2user`, Nginx, Samba zip-deploy pipeline, and Pi-hole DNS.

### zigbee2mqtt

- **Installed via**: pnpm, separate `infrastructure.config.js` PM2 config
- **Zigbee dongle**: Nabu Casa ZBT-2, paired and running
- **Sensors**: 3× ThirdReality Gen2 soil moisture sensors — **not yet paired**
- **Next step**: pair sensors, rename to convention `soil-pump-00`, `soil-pump-01`, `soil-pump-02`
- **MQTT flow**: not yet verified end-to-end

---

## Watering Parameters

| Parameter | Value |
|-----------|-------|
| Max per event | 50ml |
| Lockout between events | 10 minutes |
| Flow rate | 1.0 ml/s (placeholder, needs calibration) |

---

## Pending / Next Steps

1. **Verify watchdog script** — add battery read fallback, confirm `set -e` doesn't block watchdog feed on I2C error
2. **Calibrate pump flow rates** — measure actual ml/s per pump, `PUT /pumps/:id` with result (saved automatically)
3. **Pair ThirdReality sensors** on zigbee2mqtt (downpour)
4. **Rename sensors** to `soil-pump-00` / `soil-pump-01` / `soil-pump-02`
5. **Verify MQTT flow** from sensors to downpour broker
6. **Build downpour dashboard** — use `GET /pumps/available` for pump count, pump API for calibration, sequence API for watering logic
7. **Wire pumps** to SSR HAT relay terminals
8. **Charge batteries** on Watchdog HAT before field deployment

---

## Operational Notes

- Always power monsoon through the Watchdog HAT input connector — never directly via Pi USB-C
- To fully power off for hardware work: `wdt -poff` or unplug Watchdog HAT input connector
- DIP switches on SSR HAT: all OFF (stack address 0, I2C `0x20`, board_index 0)
- The watchdog default timeout is 120 seconds — if `monsoon-watchdog.sh` cron stops running, Pi will reboot after 2 minutes
- Node.js 20.x installed via NodeSource
- `pumps.json` is gitignored — it lives only on the Pi at `/opt/monsoon/pumps.json`
- Full API reference is in `API.md` in this repo
