# Monsoon Relay Agent

Thin HTTP-to-I2C bridge for Raspberry Pi automated watering system.
Runs on `monsoon.lan:80`, controlled remotely by the dashboard on `192.168.3.50`.

---

## Hardware Stack

- Raspberry Pi 2 (ARMv7, 1GB RAM, no WiFi — use USB dongle or ethernet)
- Sequent Microsystems Super Watchdog HAT (UPS + hardware watchdog)
- Sequent Microsystems 16-channel Solid State Relay HAT (I2C, stackable)
- 14× Kamoer NKP peristaltic pumps (12V DC, BPT tubing)
- 12V DC power supply (feeds watchdog HAT which steps down to 5V for Pi)

---

## Deployment Guide

### 1. Prepare the SD card

Flash Raspberry Pi OS Lite (32-bit, no desktop) using Raspberry Pi Imager.
In Imager advanced settings before flashing:

- Set hostname: `monsoon`
- Enable SSH with password or key
- Set locale/timezone
- Configure WiFi if not using ethernet

### 2. First boot and system setup

```bash
ssh pi@monsoon.local

# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18+ (Pi 2 is ARMv7 — use NodeSource)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node -v   # should be >= 18
npm -v

# Install build tools (needed for i2c-bus native addon later)
sudo apt install -y build-essential python3 i2c-tools

# Enable I2C bus
sudo raspi-config
# → Interface Options → I2C → Enable
# Reboot when prompted
sudo reboot
```

### 3. Verify I2C after reboot

```bash
ssh pi@monsoon.local

# Check I2C bus exists
ls /dev/i2c-*
# Should show /dev/i2c-1

# Scan for devices (with HATs mounted)
sudo i2cdetect -y 1
# Should show addresses for the relay board and watchdog
```

### 4. Deploy the relay agent

```bash
# Create app directory
sudo mkdir -p /opt/monsoon
sudo chown pi:pi /opt/monsoon

# Copy files (from your workstation)
# Option A: scp
scp -r monsoon-relay-agent/* pi@monsoon.local:/opt/monsoon/

# Option B: git (if you push to a repo)
# cd /opt/monsoon && git clone <repo-url> .

# Install dependencies
cd /opt/monsoon
npm install --production
```

### 5. Test manually

```bash
# Start in dummy mode (no real I2C calls)
MONSOON_DUMMY=1 node server.js

# From another terminal or your workstation:
curl http://monsoon.local/health
curl -X POST http://monsoon.local/relay/0/on
curl http://monsoon.local/relay/status
curl -X POST http://monsoon.local/relay/all-off
```

### 6. Set up as a systemd service

```bash
sudo tee /etc/systemd/system/monsoon.service > /dev/null << 'EOF'
[Unit]
Description=Monsoon Relay Agent
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/monsoon
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=MONSOON_DUMMY=1
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable monsoon
sudo systemctl start monsoon
sudo systemctl status monsoon
```

**Note:** runs as root because port 80 requires elevated privileges and I2C
bus access on the Pi needs root or specific group membership. If you prefer
running as `pi`, either use a port above 1024 with Nginx in front, or add
`pi` to the `i2c` group and use `setcap` on the node binary for port 80.

### 7. Switch from dummy to real hardware

Once HATs are mounted and I2C is confirmed working:

```bash
# Install the i2c-bus package
cd /opt/monsoon
npm install i2c-bus

# Edit the service to disable dummy mode
sudo systemctl edit monsoon --force
# Add:
# [Service]
# Environment=MONSOON_DUMMY=0

sudo systemctl restart monsoon
```

Then implement the I2C writes in `relay.js` (the `i2cWrite` function)
using the Sequent 16relind register map.

### 8. DNS setup

Add `monsoon.lan → <Pi's IP>` in your Pi-hole Local DNS Records.

### 9. Watchdog setup

```bash
# Install Sequent watchdog tools
git clone https://github.com/SequentMicrosystems/wdt-rpi.git
cd wdt-rpi
sudo make install

# Test
wdt -h
```

The relay agent has a `/watchdog/reset` endpoint. The dashboard on your
server should call this periodically. Alternatively, add a cron job on
the Pi itself:

```bash
# Feed watchdog every 60s (timeout is 120s)
echo "* * * * * root /usr/local/bin/wdt -r" | sudo tee /etc/cron.d/monsoon-watchdog
```

---

## API Reference

Base URL: `http://monsoon.lan`

All responses are JSON. Successful operations return `{ "ok": true, ... }`.
Failed operations return `{ "ok": false, "error": "..." }` with HTTP 400.

---

### Relay Control

#### GET /relay/status

Returns the state of all 16 relay channels.

**Response:**
```json
{
  "channels": [
    { "channel": 0, "on": true, "active_ms": 4523 },
    { "channel": 1, "on": false, "active_ms": 0 }
  ],
  "dummy_mode": true,
  "sequence_running": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `channels[].channel` | int | Channel index (0-15) |
| `channels[].on` | bool | Whether relay is currently energized |
| `channels[].active_ms` | int | Milliseconds since activation (0 if off) |
| `dummy_mode` | bool | True if running without real I2C hardware |
| `sequence_running` | bool | True if a watering sequence is in progress |

---

#### POST /relay/:id/on

Activate a single relay. Stays on until explicitly turned off or safety
timeout (120s) triggers.

**Parameters:**
- `:id` — channel number (0-15)

**Response:**
```json
{ "ok": true, "channel": 0, "action": "on" }
```

**Errors:**
- Channel out of range
- Channel already active
- Channel in cooldown (5s minimum between activations)

---

#### POST /relay/:id/off

Deactivate a single relay.

**Parameters:**
- `:id` — channel number (0-15)

**Response:**
```json
{ "ok": true, "channel": 0, "action": "off", "ran_ms": 4523 }
```

| Field | Type | Description |
|-------|------|-------------|
| `ran_ms` | int | How long the relay was active before being turned off |

---

#### POST /relay/:id/pulse

Activate a relay for a specified duration, then automatically turn it off.

**Parameters:**
- `:id` — channel number (0-15)

**Request body:**
```json
{ "duration_ms": 10000 }
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `duration_ms` | int | yes | 100 – 120000 |

**Response:**
```json
{ "ok": true, "channel": 0, "action": "pulse", "duration_ms": 10000 }
```

---

#### POST /relay/:id/dispense

Water a specific pump by volume in millilitres. Duration is calculated
from the pump's `flow_ml_per_s` calibration value.

**Parameters:**
- `:id` — pump id (0-13), not channel number

**Request body:**
```json
{ "ml": 50 }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ml` | float | yes | Volume to dispense. Must be positive. |

**Response:**
```json
{
  "ok": true,
  "pump_id": 0,
  "action": "dispense",
  "ml": 50,
  "duration_ms": 50000
}
```

**Note:** accuracy depends on calibration. Run the calibration procedure
for each pump before relying on volume-based dispensing.

---

#### POST /relay/all-off

Emergency stop. Immediately deactivates all 16 relay channels. Also aborts
any running sequence.

**Response:**
```json
{ "ok": true, "action": "all_off", "channels": 16 }
```

---

### Watering Sequences

Sequences run multiple pump operations one after another. Only one sequence
can run at a time. The sequence endpoint returns immediately — poll
`/sequence/status` for progress.

#### POST /sequence/start

Start a watering sequence. Each step specifies a pump and either a volume
(ml) or a duration (duration_ms). Steps execute sequentially with a 5s
cooldown gap between each.

**Request body:**
```json
{
  "steps": [
    { "pump_id": 0, "ml": 50 },
    { "pump_id": 1, "ml": 30 },
    { "pump_id": 5, "duration_ms": 15000 }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `steps` | array | yes | Non-empty array of step objects |
| `steps[].pump_id` | int | yes | Pump id (0-13) |
| `steps[].ml` | float | either | Volume to dispense |
| `steps[].duration_ms` | int | either | Raw duration if not using volume |

**Response (immediate):**
```json
{ "ok": true, "action": "sequence_started", "steps": 3 }
```

---

#### GET /sequence/status

Poll the progress of a running sequence.

**Response:**
```json
{
  "running": true,
  "steps": [
    { "pump_id": 0, "ml": 50, "index": 0, "status": "done", "actual_ms": 50000 },
    { "pump_id": 1, "ml": 30, "index": 1, "status": "running", "actual_ms": 30000 },
    { "pump_id": 5, "duration_ms": 15000, "index": 2, "status": "pending" }
  ]
}
```

| Step status | Meaning |
|-------------|---------|
| `pending` | Not yet started |
| `running` | Currently active |
| `done` | Completed successfully |
| `skipped` | Pump not found, disabled, or exceeds max duration |
| `failed` | Activation error (e.g. cooldown) |
| `aborted` | Sequence was aborted before this step ran |

---

#### POST /sequence/abort

Abort a running sequence. All active relays are immediately turned off.
Remaining steps are marked as `aborted`.

**Response:**
```json
{ "ok": true, "action": "sequence_aborted" }
```

---

### Pump Configuration

#### GET /pumps

Returns all pump definitions.

**Response:**
```json
{
  "pumps": [
    {
      "id": 0,
      "channel": 0,
      "name": "pump-00",
      "enabled": true,
      "flow_ml_per_s": 1.0
    }
  ]
}
```

---

#### GET /pumps/:id

Returns a single pump's configuration.

---

#### PUT /pumps/:id

Update a pump's name, enabled state, or calibration value. Changes are
held in memory — they reset on service restart. Persistent config will
be managed by the dashboard's database.

**Request body (all fields optional):**
```json
{
  "name": "kitchen-herbs",
  "enabled": true,
  "flow_ml_per_s": 1.35
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Human-readable pump label |
| `enabled` | bool | Whether this pump responds to commands |
| `flow_ml_per_s` | float | Calibrated flow rate (must be > 0) |

**Response:**
```json
{ "ok": true, "pump": { "id": 0, "channel": 0, "name": "kitchen-herbs", "enabled": true, "flow_ml_per_s": 1.35 } }
```

---

### Watering Log

#### GET /log

Returns recent watering events from the in-memory ring buffer (max 200 entries).

**Query parameters:**
- `limit` (int, optional, default 50) — number of entries to return

**Response:**
```json
{
  "entries": [
    { "event": "on", "channel": 0, "timestamp": "2026-03-09T14:22:01.123Z" },
    { "event": "off", "channel": 0, "ran_ms": 10023, "timestamp": "2026-03-09T14:22:11.146Z" },
    { "event": "dispense", "pump_id": 3, "ml": 50, "calculated_ms": 50000, "timestamp": "..." },
    { "event": "sequence_start", "steps": 5, "timestamp": "..." },
    { "event": "safety_cutoff", "channel": 7, "timestamp": "..." }
  ]
}
```

| Event type | Meaning |
|------------|---------|
| `on` | Relay activated |
| `off` | Relay deactivated (includes `ran_ms`) |
| `pulse` | Timed activation started |
| `dispense` | Volume-based dispensing started |
| `safety_cutoff` | Relay hit max duration limit and was forced off |
| `all_off` | Emergency all-off triggered |
| `sequence_start` | Sequence began |
| `sequence_end` | Sequence finished or was aborted |
| `sequence_abort` | Sequence abort requested |

---

### System & Health

#### GET /health

Lightweight health check. Use this for uptime monitoring from the dashboard.

**Response:**
```json
{
  "ok": true,
  "hostname": "monsoon",
  "uptime_s": 86400,
  "system_uptime_s": 172800,
  "dummy_mode": false,
  "memory": { "total_mb": 1024, "free_mb": 780 },
  "load": [0.12, 0.08, 0.05]
}
```

---

#### GET /system

Detailed system information. Pi-specific metrics.

**Response:**
```json
{
  "ok": true,
  "cpu_temp_c": 42.3,
  "i2c_available": true,
  "disk": { "size": "15G", "used": "2.1G", "avail": "12G", "percent": "15%" },
  "network": { "eth0": "192.168.3.60" }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `cpu_temp_c` | float/null | CPU temperature in Celsius (null if not readable) |
| `i2c_available` | bool | Whether /dev/i2c-1 exists |
| `disk` | object/null | Root partition usage |
| `network` | object | Non-internal IPv4 interfaces and addresses |

---

### Watchdog

#### POST /watchdog/reset

Feed the Sequent hardware watchdog timer. Must be called at least once
every 120 seconds (default timeout) to prevent the watchdog from
power-cycling the Pi.

**Response:**
```json
{ "ok": true, "action": "watchdog_reset" }
```

---

#### GET /watchdog/status

Query watchdog state.

**Response:**
```json
{ "ok": true, "active": false }
```

---

## Safety Mechanisms

| Mechanism | Scope | Description |
|-----------|-------|-------------|
| Max pump duration | Per-channel | Any relay active longer than 120s is force-deactivated |
| Cooldown period | Per-channel | 5s minimum between consecutive activations of the same channel |
| Hardware watchdog | System | Sequent HAT power-cycles Pi if agent stops responding |
| UPS battery | System | Clean shutdown on power loss instead of SD card corruption |
| All-off endpoint | Global | Emergency kill for all relays from dashboard or curl |
| Sequence abort | Global | Stops multi-pump sequence and kills all active relays |

---

## Calibration Procedure

Before using volume-based dispensing (`/relay/:id/dispense`), calibrate
each pump:

1. Place the pump's output tube into a measuring cup
2. Call `POST /relay/<channel>/pulse` with `{ "duration_ms": 10000 }`
3. Measure the output in ml
4. Calculate: `flow_ml_per_s = measured_ml / 10`
5. Update: `PUT /pumps/<id>` with `{ "flow_ml_per_s": <calculated> }`
6. Repeat for each pump

Recalibrate periodically — tube fatigue reduces flow rate over time.

---

## File Structure

```
/opt/monsoon/
├── server.js       Express HTTP API
├── relay.js        Hardware abstraction (I2C or dummy)
├── config.js       Pump definitions, safety limits, port
├── package.json    Dependencies (express only)
└── node_modules/
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MONSOON_DUMMY` | `1` (dummy on) | Set to `0` for real I2C hardware |
| `MONSOON_PORT` | `80` | HTTP listen port |

---

## Dashboard Integration

The dashboard running on `192.168.3.50` consumes this API. Typical polling
pattern:

- **Every 2-5s:** `GET /relay/status` — update pump indicators
- **Every 30s:** `GET /health` — connectivity and resource check
- **Every 60s:** `POST /watchdog/reset` — keep hardware watchdog alive
- **On demand:** `POST /sequence/start` — trigger scheduled watering
- **On demand:** `GET /log?limit=50` — show recent activity
