# Monsoon — Claude Code Handover

## Project Overview

Monsoon is a Raspberry Pi-based automated terrace irrigation system. The Pi (`monsoon`, `192.168.3.70`) acts as a thin relay agent controlling peristaltic pumps via a Sequent SSR HAT over I2C. The dashboard and broader infrastructure run on a separate Debian deploy server (`downpour`, `192.168.3.50`).

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
  - **Sixteen SSR HAT** (SKU SM-I-023) — I2C `0x20`, repo `16relind-rpi`, DIP all OFF
- **I2C**: enabled, `/dev/i2c-1` and `/dev/i2c-2` present
- **Power**: flows through Watchdog HAT — do not power Pi directly via USB-C

---

## Software — monsoon

### Relay Agent

- **Location**: `/opt/monsoon/`
- **Entry point**: `server.js`
- **Config**: `config.js`
- **Service**: `/etc/systemd/system/monsoon.service`, runs as `root`
- **Mode**: `MONSOON_DUMMY=0` (live mode, HATs active)
- **Port**: `80` (default) or via `MONSOON_PORT` env var

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

#### config.js highlights

```js
RELAY_BOARD_ADDRESSES = [0x20]   // SSR HAT I2C address
TOTAL_CHANNELS = 16
MAX_PUMP_DURATION_MS = 120_000   // 2 min hard cap
MIN_COOLDOWN_MS = 5_000          // 5s between activations
PUMPS = 14 pumps, channels 0–13
  flow_ml_per_s: 1.0             // placeholder — needs calibration
DUMMY_MODE: process.env.MONSOON_DUMMY !== '0'  // dummy unless MONSOON_DUMMY=0
```

### Watchdog Script

- **Location**: `/usr/local/sbin/monsoon-watchdog.sh`
- **Cron**: `* * * * *` (root crontab, every minute)
- **Purpose**: feeds hardware watchdog via `wdt -r`; initiates clean shutdown if battery drops below threshold
- **Threshold**: `BATTERY_MIN_MV=3600` — **consider raising to 3700–3800** for safer shutdown margin
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

`set -euo pipefail` will exit immediately if `wdt -g vb` fails. This means the watchdog never gets fed. Recommend adding a fallback:

```bash
battery_mv=$("$WDT_BIN" -g vb 2>/dev/null) || {
    log "WARN could not read battery voltage, resetting watchdog anyway"
    "$WDT_BIN" -r
    exit 0
}
```

### Installed HAT CLIs

```bash
# SSR HAT
16relind 0 test       # cycle all 16 relays
16relind 0 rwr <n> <0|1>  # write relay n

# Watchdog
wdt -r               # feed
wdt -g vb            # battery mV
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
2. **Calibrate pump flow rates** — measure actual ml/s per pump, update `config.js`
3. **Pair ThirdReality sensors** on zigbee2mqtt (downpour)
4. **Rename sensors** to `soil-pump-00` / `soil-pump-01` / `soil-pump-02`
5. **Verify MQTT flow** from sensors to downpour broker
6. **Build downpour dashboard** — sensor registry, pump mapping, auto-watering logic with hysteresis (spec written previously)
7. **Wire pumps** to SSR HAT relay terminals
8. **Charge batteries** on Watchdog HAT before field deployment

---

## Operational Notes

- Always power monsoon through the Watchdog HAT input connector — never directly via Pi USB-C
- To fully power off for hardware work: `wdt -poff` or unplug Watchdog HAT input connector
- DIP switches on SSR HAT: all OFF (stack address 0, I2C `0x20`, RS485 disabled)
- The watchdog default timeout is 120 seconds — if `monsoon-watchdog.sh` cron stops running, Pi will reboot after 2 minutes
- Node.js 20.x installed via NodeSource
