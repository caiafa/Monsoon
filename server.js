// monsoon relay agent — HTTP API
// Thin bridge between network calls and relay hardware

const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');
const relay = require('./relay');

const app = express();
app.use(express.json());

// In-memory watchdog event log
const WATCHDOG_LOG_MAX = 100;
const watchdogLog = [];
function logWatchdog(event) {
  watchdogLog.push({ timestamp: new Date().toISOString(), ...event });
  if (watchdogLog.length > WATCHDOG_LOG_MAX) watchdogLog.shift();
}

// --- Middleware: request logging ---

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// --- CORS: allow dashboard on deploy server to call us ---

app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.options('*', (_req, res) => res.sendStatus(204));

// ============================================================
//  RELAY ENDPOINTS
// ============================================================

// All channel states
app.get('/relay/status', (_req, res) => {
  res.json(relay.getStatus());
});

// Activate single relay
app.post('/relay/:id/on', (req, res) => {
  const channel = parseInt(req.params.id, 10);
  if (isNaN(channel)) return res.status(400).json({ ok: false, error: 'Invalid channel id' });
  const result = relay.activate(channel);
  res.status(result.ok ? 200 : 400).json(result);
});

// Deactivate single relay
app.post('/relay/:id/off', (req, res) => {
  const channel = parseInt(req.params.id, 10);
  if (isNaN(channel)) return res.status(400).json({ ok: false, error: 'Invalid channel id' });
  const result = relay.deactivate(channel);
  res.status(result.ok ? 200 : 400).json(result);
});

// Pulse — on for N ms, then auto-off
app.post('/relay/:id/pulse', (req, res) => {
  const channel = parseInt(req.params.id, 10);
  if (isNaN(channel)) return res.status(400).json({ ok: false, error: 'Invalid channel id' });

  const duration = parseInt(req.body.duration_ms, 10);
  if (isNaN(duration)) return res.status(400).json({ ok: false, error: 'Missing or invalid duration_ms in body' });

  const result = relay.pulse(channel, duration);
  res.status(result.ok ? 200 : 400).json(result);
});

// Dispense by volume — calculates duration from pump calibration
app.post('/relay/:id/dispense', (req, res) => {
  const pumpId = parseInt(req.params.id, 10);
  if (isNaN(pumpId)) return res.status(400).json({ ok: false, error: 'Invalid pump id' });

  const ml = parseFloat(req.body.ml);
  if (isNaN(ml)) return res.status(400).json({ ok: false, error: 'Missing or invalid ml in body' });

  const result = relay.dispense(pumpId, ml);
  res.status(result.ok ? 200 : 400).json(result);
});

// Emergency — all relays off immediately (also clears fan hardware relay)
app.post('/relay/all-off', (_req, res) => {
  fanState = false;
  res.json(relay.allOff());
});

// All relays on — for wiring/hardware tests
app.post('/relay/all-on', (_req, res) => {
  res.json(relay.allOn());
});

// Per-channel activation history and stats
app.get('/relay/:id/history', (req, res) => {
  const channel = parseInt(req.params.id, 10);
  if (isNaN(channel)) return res.status(400).json({ ok: false, error: 'Invalid channel id' });
  const history = relay.getChannelHistory(channel);
  if (!history) return res.status(404).json({ ok: false, error: `Channel ${channel} out of range` });
  res.json({ ok: true, ...history });
});

// Safe state — which state this relay should be in on startup
app.get('/relay/:id/safe-state', (req, res) => {
  const channel = parseInt(req.params.id, 10);
  if (isNaN(channel)) return res.status(400).json({ ok: false, error: 'Invalid channel id' });
  const state = relay.getSafeState(channel);
  if (state === null) return res.status(404).json({ ok: false, error: `Channel ${channel} out of range` });
  res.json({ ok: true, channel, safe_state: state ? 'on' : 'off' });
});

app.put('/relay/:id/safe-state', (req, res) => {
  const channel = parseInt(req.params.id, 10);
  if (isNaN(channel)) return res.status(400).json({ ok: false, error: 'Invalid channel id' });
  const { state } = req.body;
  if (state !== 'on' && state !== 'off') {
    return res.status(400).json({ ok: false, error: 'state must be "on" or "off"' });
  }
  const ok = relay.setSafeState(channel, state === 'on');
  if (!ok) return res.status(404).json({ ok: false, error: `Channel ${channel} out of range` });
  res.json({ ok: true, channel, safe_state: state });
});

// ============================================================
//  SEQUENCE ENDPOINTS
// ============================================================

// Start a watering sequence — pumps run one after another
app.post('/sequence/start', (req, res) => {
  const steps = req.body.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ ok: false, error: 'Body must contain a non-empty steps array' });
  }

  // Validate step shape
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (typeof s.pump_id !== 'number') {
      return res.status(400).json({ ok: false, error: `Step ${i}: missing or invalid pump_id` });
    }
    if (!s.ml && !s.duration_ms) {
      return res.status(400).json({ ok: false, error: `Step ${i}: must have ml or duration_ms` });
    }
  }

  // Run async — respond immediately, poll /sequence/status for progress
  relay.runSequence(steps).then(result => {
    console.log(`Sequence complete: ${result.ok ? 'success' : result.error}`);
  });

  res.json({ ok: true, action: 'sequence_started', steps: steps.length });
});

// Abort a running sequence
app.post('/sequence/abort', (_req, res) => {
  const result = relay.abortSequence();
  res.status(result.ok ? 200 : 400).json(result);
});

// Poll sequence progress
app.get('/sequence/status', (_req, res) => {
  res.json(relay.getSequenceStatus());
});

// Past sequence runs
app.get('/sequence/history', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 20;
  res.json({ entries: relay.getSequenceHistory(limit) });
});

// Emergency stop — abort sequence + all relays off + log reason (also clears fan)
app.post('/emergency-stop', (req, res) => {
  fanState = false;
  const reason = req.body && req.body.reason ? String(req.body.reason) : null;
  res.json(relay.emergencyStop(reason));
});

// ============================================================
//  FAN — optional 12V fan on last relay of board 0
// ============================================================
//
// Wired to board 0, relay 16 (16relind CLI uses 1-indexed relay numbers).
// Tracked independently from pump relays. Default state: ON.
// Note: /relay/all-off and /emergency-stop also clear the fan relay at the
// hardware level (all-relay bitmask write) — fanState is updated accordingly.

let fanState = true; // default: on

function setFanHardware(on) {
  if (config.DUMMY_MODE) {
    console.log(`[DUMMY] fan -> ${on ? 'ON' : 'OFF'}`);
    return;
  }
  const state = on ? 1 : 0;
  try {
    execSync(`16relind ${config.FAN_BOARD} write ${config.FAN_RELAY} ${state}`, { timeout: 3000, stdio: 'pipe' });
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString().trim() : err.message;
    console.error(`[FAN] Hardware write failed: ${msg}`);
    throw new Error(`Fan hardware write failed: ${msg}`);
  }
}

app.get('/fan/status', (_req, res) => {
  res.json({ ok: true, on: fanState });
});

app.post('/fan/on', (_req, res) => {
  try {
    setFanHardware(true);
    fanState = true;
    res.json({ ok: true, action: 'fan_on' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/fan/off', (_req, res) => {
  try {
    setFanHardware(false);
    fanState = false;
    res.json({ ok: true, action: 'fan_off' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================
//  PUMP CONFIGURATION
// ============================================================

// Get all pump configs
app.get('/pumps', (_req, res) => {
  res.json({ pumps: config.PUMPS });
});

// Available pump count — lightweight discovery endpoint for clients
app.get('/pumps/available', (_req, res) => {
  const total = config.PUMPS.length;
  const enabled = config.PUMPS.filter(p => p.enabled).length;
  res.json({
    ok: true,
    total_pumps: total,
    enabled_pumps: enabled,
    hats: config.HATS.map(h => ({
      address: `0x${h.address.toString(16).toUpperCase()}`,
      board_index: h.board_index,
      pump_count: h.pump_count,
    })),
  });
});

// Get single pump config
app.get('/pumps/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const pump = config.PUMPS.find(p => p.id === id);
  if (!pump) return res.status(404).json({ ok: false, error: `Pump ${id} not found` });
  res.json(pump);
});

// Update pump config (name, calibration, enabled)
app.put('/pumps/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const pump = config.PUMPS.find(p => p.id === id);
  if (!pump) return res.status(404).json({ ok: false, error: `Pump ${id} not found` });

  if (req.body.name !== undefined) pump.name = String(req.body.name);
  if (req.body.enabled !== undefined) pump.enabled = Boolean(req.body.enabled);
  if (req.body.flow_ml_per_s !== undefined) {
    const flow = parseFloat(req.body.flow_ml_per_s);
    if (isNaN(flow) || flow <= 0) return res.status(400).json({ ok: false, error: 'flow_ml_per_s must be positive' });
    pump.flow_ml_per_s = flow;
  }

  savePumpCalibration();
  res.json({ ok: true, pump });
});

// ============================================================
//  WATERING LOG
// ============================================================

app.get('/log', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  res.json({ entries: relay.getLog(limit) });
});

// ============================================================
//  SYSTEM & HEALTH
// ============================================================

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    hostname: os.hostname(),
    uptime_s: Math.floor(process.uptime()),
    system_uptime_s: os.uptime(),
    dummy_mode: config.DUMMY_MODE,
    memory: {
      total_mb: Math.round(os.totalmem() / 1024 / 1024),
      free_mb: Math.round(os.freemem() / 1024 / 1024),
    },
    load: os.loadavg(),
  });
});

app.get('/system', (_req, res) => {
  const info = { ok: true };

  // CPU temperature (Pi-specific)
  try {
    const tempRaw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim();
    info.cpu_temp_c = parseInt(tempRaw, 10) / 1000;
  } catch {
    info.cpu_temp_c = null;
  }

  // I2C bus check — just detect if the bus file exists
  info.i2c_available = fs.existsSync('/dev/i2c-1');

  // Disk usage
  try {
    const df = execSync('df -h / --output=size,used,avail,pcent', { encoding: 'utf8', timeout: 3000 });
    const lines = df.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].trim().split(/\s+/);
      info.disk = { size: parts[0], used: parts[1], avail: parts[2], percent: parts[3] };
    }
  } catch {
    info.disk = null;
  }

  // Network interfaces (non-internal only)
  const nets = os.networkInterfaces();
  info.network = {};
  for (const [name, addrs] of Object.entries(nets)) {
    const external = addrs.filter(a => !a.internal && a.family === 'IPv4');
    if (external.length > 0) info.network[name] = external[0].address;
  }

  res.json(info);
});

// Update runtime config values (changes are in-memory only, reset on restart)
app.put('/system/config', (req, res) => {
  const updated = {};

  if (req.body.battery_low_mv !== undefined) {
    const val = parseInt(req.body.battery_low_mv, 10);
    if (isNaN(val) || val <= 0) return res.status(400).json({ ok: false, error: 'battery_low_mv must be a positive integer' });
    config.BATTERY_LOW_MV = val;
    updated.battery_low_mv = val;
  }
  if (req.body.battery_critical_mv !== undefined) {
    const val = parseInt(req.body.battery_critical_mv, 10);
    if (isNaN(val) || val <= 0) return res.status(400).json({ ok: false, error: 'battery_critical_mv must be a positive integer' });
    config.BATTERY_CRITICAL_MV = val;
    updated.battery_critical_mv = val;
  }
  if (req.body.max_pump_duration_ms !== undefined) {
    const val = parseInt(req.body.max_pump_duration_ms, 10);
    if (isNaN(val) || val < 1000) return res.status(400).json({ ok: false, error: 'max_pump_duration_ms must be >= 1000' });
    config.MAX_PUMP_DURATION_MS = val;
    updated.max_pump_duration_ms = val;
  }
  if (req.body.min_cooldown_ms !== undefined) {
    const val = parseInt(req.body.min_cooldown_ms, 10);
    if (isNaN(val) || val < 0) return res.status(400).json({ ok: false, error: 'min_cooldown_ms must be >= 0' });
    config.MIN_COOLDOWN_MS = val;
    updated.min_cooldown_ms = val;
  }

  if (Object.keys(updated).length === 0) {
    return res.status(400).json({ ok: false, error: 'No recognized config keys provided. Accepted: battery_low_mv, battery_critical_mv, max_pump_duration_ms, min_cooldown_ms' });
  }

  res.json({ ok: true, updated });
});

// Prometheus-compatible metrics
app.get('/metrics', (_req, res) => {
  const status = relay.getStatus();
  const lines = [];

  lines.push('# HELP monsoon_relay_on Relay on state (1=on, 0=off)');
  lines.push('# TYPE monsoon_relay_on gauge');
  for (const ch of status.channels) {
    lines.push(`monsoon_relay_on{channel="${ch.channel}"} ${ch.on ? 1 : 0}`);
  }

  lines.push('# HELP monsoon_relay_active_ms Current active duration in milliseconds');
  lines.push('# TYPE monsoon_relay_active_ms gauge');
  for (const ch of status.channels) {
    lines.push(`monsoon_relay_active_ms{channel="${ch.channel}"} ${ch.active_ms}`);
  }

  lines.push('# HELP monsoon_relay_toggle_total Total number of relay activations');
  lines.push('# TYPE monsoon_relay_toggle_total counter');
  for (let i = 0; i < config.TOTAL_CHANNELS; i++) {
    const h = relay.getChannelHistory(i);
    lines.push(`monsoon_relay_toggle_total{channel="${i}"} ${h.toggle_count}`);
  }

  lines.push('# HELP monsoon_relay_on_ms_total Total milliseconds relay has been on');
  lines.push('# TYPE monsoon_relay_on_ms_total counter');
  for (let i = 0; i < config.TOTAL_CHANNELS; i++) {
    const h = relay.getChannelHistory(i);
    lines.push(`monsoon_relay_on_ms_total{channel="${i}"} ${h.total_on_ms}`);
  }

  lines.push('# HELP monsoon_sequence_running Whether a sequence is currently running (1=yes)');
  lines.push('# TYPE monsoon_sequence_running gauge');
  lines.push(`monsoon_sequence_running ${status.sequence_running ? 1 : 0}`);

  lines.push('# HELP monsoon_process_uptime_seconds Process uptime in seconds');
  lines.push('# TYPE monsoon_process_uptime_seconds gauge');
  lines.push(`monsoon_process_uptime_seconds ${Math.floor(process.uptime())}`);

  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send(lines.join('\n') + '\n');
});

// Active alerts — battery, power, relay safety cutoffs
app.get('/alerts', (_req, res) => {
  const alerts = [];

  if (!config.DUMMY_MODE) {
    const vbRaw = wdtExec('-g vb', true);
    const mv = vbRaw ? parseInt(vbRaw, 10) : null;
    if (mv !== null) {
      if (mv < config.BATTERY_CRITICAL_MV) {
        alerts.push({ level: 'critical', source: 'battery', message: `Battery critically low: ${mv}mV (threshold: ${config.BATTERY_CRITICAL_MV}mV)`, mv });
      } else if (mv < config.BATTERY_LOW_MV) {
        alerts.push({ level: 'warning', source: 'battery', message: `Battery low: ${mv}mV (threshold: ${config.BATTERY_LOW_MV}mV)`, mv });
      }
    }

    const vinRaw = wdtExec('-g vin', true);
    const vin = vinRaw ? parseInt(vinRaw, 10) : null;
    if (vin !== null && vin < 4000) {
      alerts.push({ level: 'warning', source: 'power', message: `Input power low or absent: ${vin}mV — running on battery`, vin });
    }
  }

  const recentLog = relay.getLog(100);
  const cutoffs = recentLog.filter(e => e.event === 'safety_cutoff');
  for (const cut of cutoffs) {
    alerts.push({ level: 'warning', source: 'relay', message: `Channel ${cut.channel} was force-cut at max duration`, timestamp: cut.timestamp, channel: cut.channel });
  }

  res.json({ ok: true, count: alerts.length, alerts });
});

// ============================================================
//  WATCHDOG
// ============================================================
//
// Sequent Microsystems Multichemistry Watchdog HAT (SM-I-033)
// CLI tool: `wdt` (from wdt-rpi, already installed)
//
// Key commands:
//   wdt -r              feed watchdog (reset countdown)
//   wdt -g vb           battery voltage in mV
//   wdt -g vin          input (external) voltage in mV
//   wdt -g p            get watchdog period in seconds
//   wdt -s p <sec>      set watchdog period
//   wdt -g rob          get restart-on-battery (0 or 1)
//   wdt -rob <0|1>      set restart-on-battery
//   wdt -poff           power off (no restart)
//   wdt -g rc           get reset count (reboots triggered by watchdog)

// Helper: run a wdt command, return trimmed stdout or null on failure
// Set quiet=true for optional/probe commands that may not be supported by all firmware versions
function wdtExec(args, quiet = false) {
  try {
    return execSync(`wdt ${args}`, { timeout: 3000, encoding: 'utf8' }).trim();
  } catch (err) {
    if (!quiet) {
      const msg = err.stderr ? err.stderr.toString().trim() : err.message;
      console.error(`[WATCHDOG] wdt ${args} failed: ${msg}`);
    }
    return null;
  }
}

// Feed the hardware watchdog timer
app.post('/watchdog/reset', (_req, res) => {
  if (config.DUMMY_MODE) {
    console.log('[DUMMY] watchdog reset');
    return res.json({ ok: true, action: 'watchdog_reset', dummy: true });
  }

  const result = wdtExec('-r');
  if (result !== null) {
    logWatchdog({ event: 'watchdog_reset' });
    res.json({ ok: true, action: 'watchdog_reset' });
  } else {
    res.status(500).json({ ok: false, error: 'Watchdog reset failed' });
  }
});

// Comprehensive watchdog status — battery, period, restart-on-battery, reset count
app.get('/watchdog/status', (_req, res) => {
  if (config.DUMMY_MODE) {
    return res.json({
      ok: true, dummy: true,
      battery: { mv: 4200, level: 'ok', low_threshold_mv: config.BATTERY_LOW_MV, critical_threshold_mv: config.BATTERY_CRITICAL_MV },
      input_mv: 5000,
      period_s: config.WATCHDOG_DEFAULT_PERIOD_S,
      restart_on_battery: false,
      reset_count: 0,
    });
  }

  const status = { ok: true };

  // Battery voltage + health assessment
  const vbRaw = wdtExec('-g vb');
  const battery_mv = vbRaw ? parseInt(vbRaw, 10) : null;
  let level = 'unknown';
  if (battery_mv !== null) {
    if (battery_mv < config.BATTERY_CRITICAL_MV) level = 'critical';
    else if (battery_mv < config.BATTERY_LOW_MV) level = 'low';
    else level = 'ok';
  }
  status.battery = {
    mv: battery_mv,
    level,
    low_threshold_mv: config.BATTERY_LOW_MV,
    critical_threshold_mv: config.BATTERY_CRITICAL_MV,
  };

  // External/input voltage (charger or power supply)
  const vinRaw = wdtExec('-g vin');
  status.input_mv = vinRaw ? parseInt(vinRaw, 10) : null;

  // Watchdog period
  const periodRaw = wdtExec('-g p');
  status.period_s = periodRaw ? parseInt(periodRaw, 10) : null;

  // Restart-on-battery setting
  const robRaw = wdtExec('-g rob');
  status.restart_on_battery = robRaw === '1';

  // Reset count — not supported on all firmware versions, so probe quietly
  const rcRaw = wdtExec('-g rc', true);
  status.reset_count = rcRaw ? parseInt(rcRaw, 10) : null;

  res.json(status);
});

// Battery-only endpoint — lightweight, for frequent polling by dashboard
app.get('/watchdog/battery', (_req, res) => {
  if (config.DUMMY_MODE) {
    return res.json({ ok: true, dummy: true, mv: 4200, level: 'ok' });
  }

  const vbRaw = wdtExec('-g vb');
  const mv = vbRaw ? parseInt(vbRaw, 10) : null;

  let level = 'unknown';
  if (mv !== null) {
    if (mv < config.BATTERY_CRITICAL_MV) level = 'critical';
    else if (mv < config.BATTERY_LOW_MV) level = 'low';
    else level = 'ok';
  }

  res.json({ ok: mv !== null, mv, level });
});

// Reboot the Pi (relays off first, then OS reboot after 2s)
app.post('/watchdog/reboot', (_req, res) => {
  if (config.DUMMY_MODE) {
    console.log('[DUMMY] reboot requested');
    return res.json({ ok: true, action: 'reboot', dummy: true });
  }

  relay.allOff();
  logWatchdog({ event: 'reboot' });

  res.json({ ok: true, action: 'reboot', message: 'Rebooting in ~2 seconds' });

  setTimeout(() => {
    console.log('[WATCHDOG] Executing reboot');
    try {
      execSync('shutdown -r now', { timeout: 3000, stdio: 'pipe' });
    } catch (err) {
      console.error('[WATCHDOG] Reboot failed:', err.message);
    }
  }, 2000);
});

// In-memory watchdog event log (resets, power-offs, reboots since last startup)
app.get('/watchdog/log', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  const n = Math.min(limit, WATCHDOG_LOG_MAX);
  res.json({ entries: watchdogLog.slice(-n) });
});

// Set watchdog timeout period (seconds). If the cron/service doesn't feed
// within this window, the HAT hard-reboots the Pi.
app.put('/watchdog/period', (req, res) => {
  const seconds = parseInt(req.body.seconds, 10);
  if (isNaN(seconds) || seconds < 10 || seconds > 65535) {
    return res.status(400).json({ ok: false, error: 'seconds must be 10–65535' });
  }

  if (config.DUMMY_MODE) {
    console.log(`[DUMMY] watchdog period -> ${seconds}s`);
    return res.json({ ok: true, action: 'period_set', seconds, dummy: true });
  }

  const result = wdtExec(`-s p ${seconds}`);
  if (result !== null) {
    res.json({ ok: true, action: 'period_set', seconds });
  } else {
    res.status(500).json({ ok: false, error: 'Failed to set watchdog period' });
  }
});

// Toggle restart-on-battery — when enabled, the Pi reboots as soon as
// external power is restored after a battery-powered period.
app.put('/watchdog/restart-on-battery', (req, res) => {
  const enabled = Boolean(req.body.enabled);

  if (config.DUMMY_MODE) {
    console.log(`[DUMMY] restart-on-battery -> ${enabled}`);
    return res.json({ ok: true, action: 'restart_on_battery', enabled, dummy: true });
  }

  const result = wdtExec(`-rob ${enabled ? 1 : 0}`);
  if (result !== null) {
    res.json({ ok: true, action: 'restart_on_battery', enabled });
  } else {
    res.status(500).json({ ok: false, error: 'Failed to set restart-on-battery' });
  }
});

// Safe power off — cuts power via the watchdog HAT. Pi will NOT restart
// unless external power is cycled (and restart-on-battery is enabled).
// Requires { confirm: true } in body to prevent accidental shutdowns.
app.post('/watchdog/power-off', (req, res) => {
  if (req.body.confirm !== true) {
    return res.status(400).json({
      ok: false,
      error: 'Send { "confirm": true } to power off. This will cut power to the Pi.',
    });
  }

  if (config.DUMMY_MODE) {
    console.log('[DUMMY] power off requested');
    return res.json({ ok: true, action: 'power_off', dummy: true });
  }

  // Turn all relays off before cutting power
  relay.allOff();

  // Respond before we lose power
  logWatchdog({ event: 'power_off' });
  res.json({ ok: true, action: 'power_off', message: 'Powering off in ~2 seconds' });

  // Give the response time to flush, then cut power
  setTimeout(() => {
    console.log('[WATCHDOG] Executing power off');
    try {
      execSync('wdt -poff', { timeout: 3000, stdio: 'pipe' });
    } catch {
      // If wdt -poff fails, fall back to OS shutdown
      execSync('shutdown -h now', { timeout: 3000, stdio: 'pipe' });
    }
  }, 2000);
});

// ============================================================
//  PUMP CALIBRATION PERSISTENCE
// ============================================================

const PUMPS_FILE = path.join(__dirname, 'pumps.json');

// Persist mutable pump fields (name, enabled, flow_ml_per_s) to disk.
// Called after every successful PUT /pumps/:id.
function savePumpCalibration() {
  const data = {};
  for (const pump of config.PUMPS) {
    data[pump.id] = { name: pump.name, enabled: pump.enabled, flow_ml_per_s: pump.flow_ml_per_s };
  }
  fs.writeFileSync(PUMPS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Load saved pump config from disk and merge into the in-memory PUMPS array.
// Hardware fields (board_index, channel) always come from config.js — only
// mutable fields are restored. Unknown pump IDs in the file are silently ignored
// (handles HATS config changes between restarts).
function loadPumpCalibration() {
  try {
    const saved = JSON.parse(fs.readFileSync(PUMPS_FILE, 'utf8'));
    for (const pump of config.PUMPS) {
      const s = saved[pump.id];
      if (!s) continue;
      if (s.name !== undefined) pump.name = s.name;
      if (s.enabled !== undefined) pump.enabled = Boolean(s.enabled);
      if (typeof s.flow_ml_per_s === 'number' && s.flow_ml_per_s > 0) pump.flow_ml_per_s = s.flow_ml_per_s;
    }
    console.log(`pump calibration loaded from ${PUMPS_FILE}`);
  } catch {
    // File doesn't exist yet — first run, use defaults from config.js
  }
}

// ============================================================
//  START
// ============================================================

// --- Startup: load saved calibration, then ensure clean relay state ---
loadPumpCalibration();
relay.allOff(); // clears all hardware relays including fan relay
try {
  setFanHardware(true); // fan default: on
} catch (err) {
  console.error('[FAN] Failed to turn on fan at startup:', err.message);
}

app.listen(config.PORT, config.HOST, () => {
  console.log(`monsoon relay agent listening on ${config.HOST}:${config.PORT}`);
  console.log(`dummy mode: ${config.DUMMY_MODE}`);
  console.log(`hats configured: ${config.HATS.length}`);
  console.log(`pumps total: ${config.PUMPS.length} (${config.PUMPS.filter(p => p.enabled).length} enabled)`);
  console.log(`max pump duration: ${config.MAX_PUMP_DURATION_MS}ms`);
});

// --- Graceful shutdown: all relays off ---
function shutdown(signal) {
  console.log(`\n${signal} received — turning all relays off`);
  relay.allOff();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
