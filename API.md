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

### POST /relay/all-on

Activate all relay channels simultaneously. Intended for wiring and hardware tests.

**Response (200)**

```json
{ "ok": true, "action": "all_on", "succeeded": 16, "total": 16 }
```

`succeeded` may be less than `total` if some channels are in cooldown.

---

### GET /relay/:id/history

Per-channel activation statistics since last startup.

**URL params**

| Param | Type | Description |
|-------|------|-------------|
| `id` | number | Channel index (0-15) |

**Response (200)**

```json
{
  "ok": true,
  "channel": 0,
  "toggle_count": 12,
  "total_on_ms": 62400,
  "last_on_at": "2026-03-28T08:15:00.000Z",
  "last_off_at": "2026-03-28T08:15:05.023Z",
  "currently_on": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `toggle_count` | number | Total activations since startup |
| `total_on_ms` | number | Cumulative on-time in milliseconds |
| `last_on_at` | string/null | ISO timestamp of last activation |
| `last_off_at` | string/null | ISO timestamp of last deactivation |
| `currently_on` | boolean | Current relay state |

---

### GET /relay/:id/safe-state

Get the configured safe state for a channel (the state it should be in on startup).

**URL params**

| Param | Type | Description |
|-------|------|-------------|
| `id` | number | Channel index (0-15) |

**Response (200)**

```json
{ "ok": true, "channel": 0, "safe_state": "off" }
```

`safe_state` is `"on"` or `"off"`. Default is `"off"` for all channels.

---

### PUT /relay/:id/safe-state

Set the safe state for a channel.

**URL params**

| Param | Type | Description |
|-------|------|-------------|
| `id` | number | Channel index (0-15) |

**Body**

```json
{ "state": "off" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `state` | string | yes | `"on"` or `"off"` |

**Response (200)**

```json
{ "ok": true, "channel": 0, "safe_state": "off" }
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

### GET /sequence/history

Past sequence runs since last startup. Returns most recent entries first.

**Query params**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | number | 20 | Number of entries to return (max 50) |

**Response**

```json
{
  "entries": [
    {
      "started_at": "2026-03-28T08:00:00.000Z",
      "ended_at": "2026-03-28T08:01:45.000Z",
      "aborted": false,
      "steps": [
        { "pump_id": 0, "ml": 25, "index": 0, "status": "done", "actual_ms": 25000 },
        { "pump_id": 1, "ml": 30, "index": 1, "status": "done", "actual_ms": 30000 }
      ]
    }
  ]
}
```

---

## Emergency Stop

### POST /emergency-stop

Immediately abort any running sequence and turn all relays off. Logs the reason.

**Body** (optional)

```json
{ "reason": "operator override" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reason` | string | no | Human-readable reason for the stop (logged) |

**Response (200)**

```json
{ "ok": true, "action": "emergency_stop", "reason": "operator override" }
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
    { "event": "on", "channel": 0, "timestamp": "2026-03-28T08:00:00.000Z" },
    { "event": "off", "channel": 0, "ran_ms": 5023, "timestamp": "2026-03-28T08:00:05.023Z" },
    { "event": "pulse", "channel": 0, "duration_ms": 5000, "timestamp": "..." },
    { "event": "dispense", "pump_id": 0, "ml": 25, "calculated_ms": 25000, "timestamp": "..." },
    { "event": "safety_cutoff", "channel": 3, "timestamp": "..." },
    { "event": "sequence_start", "steps": 3, "timestamp": "..." },
    { "event": "sequence_end", "aborted": false, "steps": 3, "timestamp": "..." },
    { "event": "sequence_abort", "timestamp": "..." },
    { "event": "all_off", "timestamp": "..." },
    { "event": "all_on", "succeeded": 16, "total": 16, "timestamp": "..." },
    { "event": "emergency_stop", "reason": "operator override", "timestamp": "..." }
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

### PUT /system/config

Update runtime config values. Changes are in-memory only and reset on service restart.

**Body** (all fields optional — send only what you want to change)

```json
{
  "battery_low_mv": 3700,
  "battery_critical_mv": 3600,
  "max_pump_duration_ms": 120000,
  "min_cooldown_ms": 5000
}
```

| Field | Type | Description |
|-------|------|-------------|
| `battery_low_mv` | number | Battery warning threshold in mV (must be > 0) |
| `battery_critical_mv` | number | Battery critical threshold in mV (must be > 0) |
| `max_pump_duration_ms` | number | Safety cutoff for any single relay activation (min 1000) |
| `min_cooldown_ms` | number | Minimum gap between activations of the same channel (min 0) |

**Response (200)**

```json
{ "ok": true, "updated": { "max_pump_duration_ms": 60000 } }
```

**Errors (400)**

```json
{ "ok": false, "error": "No recognized config keys provided. Accepted: battery_low_mv, battery_critical_mv, max_pump_duration_ms, min_cooldown_ms" }
```

---

### GET /metrics

Prometheus-compatible metrics endpoint. Returns relay states, cumulative on-times, toggle counts, and process uptime.

**Response** — `Content-Type: text/plain; version=0.0.4`

```
# HELP monsoon_relay_on Relay on state (1=on, 0=off)
# TYPE monsoon_relay_on gauge
monsoon_relay_on{channel="0"} 0
monsoon_relay_on{channel="1"} 1
...
# HELP monsoon_relay_active_ms Current active duration in milliseconds
# TYPE monsoon_relay_active_ms gauge
monsoon_relay_active_ms{channel="0"} 0
monsoon_relay_active_ms{channel="1"} 4320
...
# HELP monsoon_relay_toggle_total Total number of relay activations
# TYPE monsoon_relay_toggle_total counter
monsoon_relay_toggle_total{channel="0"} 12
...
# HELP monsoon_relay_on_ms_total Total milliseconds relay has been on
# TYPE monsoon_relay_on_ms_total counter
monsoon_relay_on_ms_total{channel="0"} 62400
...
# HELP monsoon_sequence_running Whether a sequence is currently running (1=yes)
# TYPE monsoon_sequence_running gauge
monsoon_sequence_running 0
# HELP monsoon_process_uptime_seconds Process uptime in seconds
# TYPE monsoon_process_uptime_seconds gauge
monsoon_process_uptime_seconds 86400
```

---

### GET /alerts

Active warning conditions. Checks battery level, input power, and recent safety cutoffs.

**Response**

```json
{
  "ok": true,
  "count": 1,
  "alerts": [
    {
      "level": "warning",
      "source": "battery",
      "message": "Battery low: 3680mV (threshold: 3700mV)",
      "mv": 3680
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `level` | `"warning"` or `"critical"` |
| `source` | `"battery"`, `"power"`, or `"relay"` |
| `message` | Human-readable description |

Alert conditions checked:
- Battery voltage below `battery_low_mv` → `warning`
- Battery voltage below `battery_critical_mv` → `critical`
- Input voltage below 4000mV (running on battery) → `warning`
- Any `safety_cutoff` events in the recent log → `warning`

In dummy mode, hardware checks are skipped; only log-based alerts fire.

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

### POST /watchdog/reboot

Gracefully reboot the Pi. Turns all relays off first, then issues an OS reboot after a 2-second delay so the response can be received.

**Response (200)** — returned before the reboot occurs

```json
{ "ok": true, "action": "reboot", "message": "Rebooting in ~2 seconds" }
```

---

### GET /watchdog/log

In-memory log of watchdog-level events since last startup: resets, reboots, and power-offs.

**Query params**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | number | 50 | Number of recent entries to return (max 100) |

**Response**

```json
{
  "entries": [
    { "event": "watchdog_reset", "timestamp": "2026-03-28T08:00:00.000Z" },
    { "event": "reboot", "timestamp": "2026-03-28T09:00:00.000Z" },
    { "event": "power_off", "timestamp": "2026-03-28T10:00:00.000Z" }
  ]
}
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
- **404** — Resource not found (unknown pump or channel id)
- **500** — Internal error (I2C failure, watchdog command failed)

---

## Safety Mechanisms

| Mechanism | Value | Description |
|-----------|-------|-------------|
| Max pump duration | 120s | Any relay auto-stops after 2 minutes |
| Cooldown | 5s | Minimum gap between activations of the same channel |
| Startup all-off | — | All relays forced off when the service starts |
| Graceful shutdown | — | SIGTERM/SIGINT turn all relays off before exit |
| Emergency stop | `POST /emergency-stop` | Abort sequence + hardware all-off + logged reason |
| Basic all-off | `POST /relay/all-off` | Hardware-level all-off + clear timers |
| Power-off guard | `confirm: true` | Prevents accidental remote shutdown |

---

## Dummy Mode

When `MONSOON_DUMMY` is not set to `0`, the agent runs in dummy mode:
- Relay commands log to console instead of writing to I2C
- Watchdog commands return plausible fake data
- All API endpoints remain functional for testing
- Responses include `dummy: true`

Set `MONSOON_DUMMY=0` in the systemd service for live hardware operation.
