# Monsoon Relay Agent — API Reference

Base URL: `http://192.168.3.70` (default port 80)

All request/response bodies are JSON. All responses include an `ok` boolean. In dummy mode, responses include `dummy: true`.

---

## Relay Control

### GET /relay/status

Get the state of all 16 relay channels.

**Response**

```json
{
  "channels": [
    { "channel": 0, "on": false, "active_ms": 0 },
    { "channel": 1, "on": true, "active_ms": 4320 }
  ],
  "dummy_mode": false,
  "sequence_running": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `channels[].channel` | number | Channel index (0-15) |
| `channels[].on` | boolean | Whether the relay is currently active |
| `channels[].active_ms` | number | Milliseconds since activation (0 if off) |
| `dummy_mode` | boolean | Whether the agent is in dummy mode |
| `sequence_running` | boolean | Whether a watering sequence is in progress |

---

### POST /relay/:id/on

Turn a single relay on. Stays on until explicitly turned off or the safety timer (120s) triggers.

**URL params**

| Param | Type | Description |
|-------|------|-------------|
| `id` | number | Channel index (0-15) |

**Response (200)**

```json
{ "ok": true, "channel": 0, "action": "on" }
```

**Errors (400)**

```json
{ "ok": false, "error": "Channel 0 already active" }
{ "ok": false, "error": "Channel 0 in cooldown (3200ms remaining)" }
```

---

### POST /relay/:id/off

Turn a single relay off.

**URL params**

| Param | Type | Description |
|-------|------|-------------|
| `id` | number | Channel index (0-15) |

**Response (200)**

```json
{ "ok": true, "channel": 0, "action": "off", "ran_ms": 5023 }
```

---

### POST /relay/:id/pulse

Turn a relay on for a specified duration, then auto-off.

**URL params**

| Param | Type | Description |
|-------|------|-------------|
| `id` | number | Channel index (0-15) |

**Body**

```json
{ "duration_ms": 5000 }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `duration_ms` | number | yes | Pulse duration in ms (100-120000) |

**Response (200)**

```json
{ "ok": true, "channel": 0, "action": "pulse", "duration_ms": 5000 }
```

---

### POST /relay/:id/dispense

Dispense a specific volume of liquid. Duration is calculated from the pump's calibrated flow rate.

**URL params**

| Param | Type | Description |
|-------|------|-------------|
| `id` | number | Pump id (0-13) |

**Body**

```json
{ "ml": 25 }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ml` | number | yes | Volume to dispense in milliliters (must be positive) |

**Response (200)**

```json
{ "ok": true, "pump_id": 0, "action": "dispense", "ml": 25, "duration_ms": 25000 }
```

**Errors (400)**

```json
{ "ok": false, "error": "Pump 0 not found" }
{ "ok": false, "error": "Pump 0 is disabled" }
{ "ok": false, "error": "Calculated duration 150000ms exceeds max — reduce volume or recalibrate" }
```

---

### POST /relay/all-off

Emergency stop. Sends a hardware-level all-off command, then clears all internal state and timers.

**Response (200)**

```json
{ "ok": true, "action": "all_off", "channels": 16 }
```

---

## Watering Sequences

Sequences run pumps one after another with automatic cooldown gaps between steps. The sequence runs asynchronously; poll `/sequence/status` for progress.

### POST /sequence/start

Start a watering sequence.

**Body**

```json
{
  "steps": [
    { "pump_id": 0, "ml": 25 },
    { "pump_id": 1, "ml": 30 },
    { "pump_id": 5, "duration_ms": 10000 }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `steps` | array | yes | Non-empty array of step objects |
| `steps[].pump_id` | number | yes | Pump id (0-13) |
| `steps[].ml` | number | one of ml/duration_ms | Volume to dispense |
| `steps[].duration_ms` | number | one of ml/duration_ms | Raw duration in ms |

**Response (200)** — returned immediately, sequence runs in background

```json
{ "ok": true, "action": "sequence_started", "steps": 3 }
```

**Errors (400)**

```json
{ "ok": false, "error": "A sequence is already running" }
{ "ok": false, "error": "Step 2: must have ml or duration_ms" }
```

---

### GET /sequence/status

Poll the progress of a running sequence.

**Response**

```json
{
  "running": true,
  "steps": [
    { "pump_id": 0, "ml": 25, "index": 0, "status": "done", "actual_ms": 25000 },
    { "pump_id": 1, "ml": 30, "index": 1, "status": "running", "actual_ms": 30000 },
    { "pump_id": 5, "duration_ms": 10000, "index": 2, "status": "pending" }
  ]
}
```

Step statuses: `pending`, `running`, `done`, `failed`, `skipped`, `aborted`

---

### POST /sequence/abort

Abort a running sequence. Turns all relays off immediately. Remaining steps are marked `aborted`.

**Response (200)**

```json
{ "ok": true, "action": "sequence_aborted" }
```

**Errors (400)**

```json
{ "ok": false, "error": "No sequence running" }
```

---

## Pump Configuration

Pump config is held in memory (resets on restart). 14 pumps configured by default (ids 0-13).

### GET /pumps

Get all pump configurations.

**Response**

```json
{
  "pumps": [
    { "id": 0, "channel": 0, "name": "pump-00", "enabled": true, "flow_ml_per_s": 1.0 },
    { "id": 1, "channel": 1, "name": "pump-01", "enabled": true, "flow_ml_per_s": 1.0 }
  ]
}
```

---

### GET /pumps/:id

Get a single pump's configuration.

**URL params**

| Param | Type | Description |
|-------|------|-------------|
| `id` | number | Pump id (0-13) |

**Response (200)**

```json
{ "id": 0, "channel": 0, "name": "pump-00", "enabled": true, "flow_ml_per_s": 1.0 }
```

---

### PUT /pumps/:id

Update a pump's name, enabled state, or calibrated flow rate. All fields are optional.

**URL params**

| Param | Type | Description |
|-------|------|-------------|
| `id` | number | Pump id (0-13) |

**Body**

```json
{ "name": "tomatoes-left", "enabled": true, "flow_ml_per_s": 1.35 }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | no | Human-readable pump name |
| `enabled` | boolean | no | Whether the pump can be activated |
| `flow_ml_per_s` | number | no | Calibrated flow rate (must be > 0) |

**Response (200)**

```json
{
  "ok": true,
  "pump": { "id": 0, "channel": 0, "name": "tomatoes-left", "enabled": true, "flow_ml_per_s": 1.35 }
}
```

---

## Watering Log

In-memory ring buffer of the last 200 events. Resets on restart.

### GET /log

**Query params**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | number | 50 | Number of recent entries to return (max 200) |

**Response**

```json
{
  "entries": [
    { "event": "on", "channel": 0, "timestamp": "2026-03-27T14:30:00.000Z" },
    { "event": "off", "channel": 0, "ran_ms": 5023, "timestamp": "2026-03-27T14:30:05.023Z" },
    { "event": "dispense", "pump_id": 0, "ml": 25, "calculated_ms": 25000, "timestamp": "..." },
    { "event": "safety_cutoff", "channel": 3, "timestamp": "..." },
    { "event": "sequence_start", "steps": 3, "timestamp": "..." },
    { "event": "sequence_end", "aborted": false, "steps": 3, "timestamp": "..." },
    { "event": "all_off", "timestamp": "..." }
  ]
}
```

---

## System & Health

### GET /health

Lightweight health check for uptime monitoring.

**Response**

```json
{
  "ok": true,
  "hostname": "monsoon",
  "uptime_s": 86400,
  "system_uptime_s": 172800,
  "dummy_mode": false,
  "memory": { "total_mb": 926, "free_mb": 512 },
  "load": [0.5, 0.3, 0.2]
}
```

---

### GET /system

Detailed system information including hardware sensors.

**Response**

```json
{
  "ok": true,
  "cpu_temp_c": 48.3,
  "i2c_available": true,
  "disk": { "size": "29G", "used": "2.1G", "avail": "25G", "percent": "8%" },
  "network": { "wlan0": "192.168.3.70" }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `cpu_temp_c` | number/null | CPU temperature in Celsius (null if unavailable) |
| `i2c_available` | boolean | Whether `/dev/i2c-1` exists |
| `disk` | object/null | Root filesystem usage |
| `network` | object | External IPv4 addresses by interface name |

---

## Watchdog

Controls the Sequent Microsystems Multichemistry Watchdog HAT (SM-I-033). The watchdog reboots the Pi if not fed within its configured period.

### POST /watchdog/reset

Feed the hardware watchdog timer, resetting its countdown.

**Response (200)**

```json
{ "ok": true, "action": "watchdog_reset" }
```

---

### GET /watchdog/status

Comprehensive watchdog status: battery health, input power, timeout period, restart policy, and reboot history.

**Response**

```json
{
  "ok": true,
  "battery": {
    "mv": 3750,
    "level": "ok",
    "low_threshold_mv": 3700,
    "critical_threshold_mv": 3600
  },
  "input_mv": 5100,
  "period_s": 120,
  "restart_on_battery": false,
  "reset_count": 2
}
```

| Field | Type | Description |
|-------|------|-------------|
| `battery.mv` | number/null | Battery voltage in millivolts |
| `battery.level` | string | `ok` (>= 3700mV), `low` (3600-3699mV), `critical` (< 3600mV), or `unknown` |
| `battery.low_threshold_mv` | number | Threshold for `low` level |
| `battery.critical_threshold_mv` | number | Threshold for `critical` level |
| `input_mv` | number/null | External power supply voltage in mV |
| `period_s` | number/null | Current watchdog timeout in seconds |
| `restart_on_battery` | boolean | Whether Pi reboots when external power returns |
| `reset_count` | number/null | Times the watchdog has rebooted the Pi |

---

### GET /watchdog/battery

Lightweight battery check for frequent dashboard polling.

**Response**

```json
{ "ok": true, "mv": 3750, "level": "ok" }
```

---

### PUT /watchdog/period

Set the watchdog timeout period. If the watchdog isn't fed within this window, the HAT hard-reboots the Pi.

**Body**

```json
{ "seconds": 120 }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `seconds` | number | yes | Timeout period (10-65535 seconds) |

**Response (200)**

```json
{ "ok": true, "action": "period_set", "seconds": 120 }
```

---

### PUT /watchdog/restart-on-battery

Toggle whether the Pi automatically restarts when external power is restored after running on battery.

**Body**

```json
{ "enabled": true }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | yes | Enable or disable restart-on-battery |

**Response (200)**

```json
{ "ok": true, "action": "restart_on_battery", "enabled": true }
```

---

### POST /watchdog/power-off

Safely power off the Pi via the watchdog HAT. Turns all relays off first, then cuts power after a 2-second delay. Requires explicit confirmation to prevent accidental shutdowns.

The Pi will NOT restart unless external power is cycled and restart-on-battery is enabled.

**Body**

```json
{ "confirm": true }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `confirm` | boolean | yes | Must be `true` to proceed |

**Response (200)**

```json
{ "ok": true, "action": "power_off", "message": "Powering off in ~2 seconds" }
```

**Errors (400)** — if confirm is missing or false

```json
{ "ok": false, "error": "Send { \"confirm\": true } to power off. This will cut power to the Pi." }
```

---

## Error Format

All error responses follow the same shape:

```json
{ "ok": false, "error": "Human-readable error description" }
```

HTTP status codes used:
- **200** — Success
- **400** — Bad request (invalid input, cooldown, already active, etc.)
- **404** — Resource not found (unknown pump id)
- **500** — Internal error (I2C failure, watchdog command failed)

---

## Safety Mechanisms

| Mechanism | Value | Description |
|-----------|-------|-------------|
| Max pump duration | 120s | Any relay auto-stops after 2 minutes |
| Cooldown | 5s | Minimum gap between activations of the same channel |
| Startup all-off | — | All relays forced off when the service starts |
| Graceful shutdown | — | SIGTERM/SIGINT turn all relays off before exit |
| Emergency stop | `/relay/all-off` | Hardware-level all-off + clear timers |
| Power-off guard | `confirm: true` | Prevents accidental remote shutdown |

---

## Dummy Mode

When `MONSOON_DUMMY` is not set to `0`, the agent runs in dummy mode:
- Relay commands log to console instead of writing to I2C
- Watchdog commands return plausible fake data
- All API endpoints remain functional for testing
- Responses include `dummy: true`

Set `MONSOON_DUMMY=0` in the systemd service for live hardware operation.
