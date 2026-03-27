// monsoon relay agent — HTTP API
// Thin bridge between network calls and relay hardware

const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const config = require('./config');
const relay = require('./relay');

const app = express();
app.use(express.json());

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

// Emergency — all relays off immediately
app.post('/relay/all-off', (_req, res) => {
  res.json(relay.allOff());
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

// ============================================================
//  PUMP CONFIGURATION
// ============================================================

// Get all pump configs
app.get('/pumps', (_req, res) => {
  res.json({ pumps: config.PUMPS });
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

// ============================================================
//  WATCHDOG
// ============================================================

// Feed the Sequent hardware watchdog timer
app.post('/watchdog/reset', (_req, res) => {
  if (config.DUMMY_MODE) {
    console.log('[DUMMY] watchdog reset');
    return res.json({ ok: true, action: 'watchdog_reset', dummy: true });
  }

  try {
    execSync('wdt -r', { timeout: 3000, stdio: 'pipe' });
    res.json({ ok: true, action: 'watchdog_reset' });
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString().trim() : err.message;
    console.error(`[WATCHDOG] reset failed: ${msg}`);
    res.status(500).json({ ok: false, error: `Watchdog reset failed: ${msg}` });
  }
});

// Get watchdog status including battery voltage
app.get('/watchdog/status', (_req, res) => {
  if (config.DUMMY_MODE) {
    return res.json({ ok: true, dummy: true, active: false });
  }

  const status = { ok: true, active: true };

  try {
    const raw = execSync('wdt -g vb', { timeout: 3000, encoding: 'utf8' }).trim();
    status.battery_mv = parseInt(raw, 10) || null;
  } catch {
    status.battery_mv = null;
    status.battery_error = 'Could not read battery voltage';
  }

  res.json(status);
});

// ============================================================
//  START
// ============================================================

// --- Startup: ensure clean relay state ---
relay.allOff();

app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`monsoon relay agent listening on :${config.PORT}`);
  console.log(`dummy mode: ${config.DUMMY_MODE}`);
  console.log(`pumps configured: ${config.PUMPS.length}`);
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
