// monsoon relay agent — relay hardware abstraction
// Manages relay state, enforces safety limits, abstracts I2C vs dummy mode

const { execSync } = require('child_process');
const config = require('./config');

// Runtime state: which channels are currently on, and when they were activated
const channelState = new Map(); // channel -> { on: boolean, activatedAt: number|null, timer: timeout|null }

// Watering log — ring buffer, kept in memory
const LOG_MAX = 200;
const wateringLog = [];

// Per-channel statistics (in-memory, resets on restart)
const channelStats = new Map();

// Sequence history — ring buffer
const SEQUENCE_HISTORY_MAX = 50;
const sequenceHistory = [];

// Per-channel safe states — desired state on startup (default off)
const safeStates = new Map();

// Sequence state
let sequenceRunning = false;
let sequenceQueue = [];
let sequenceAborted = false;

// Initialize all channels as off
for (let i = 0; i < config.TOTAL_CHANNELS; i++) {
  channelState.set(i, { on: false, activatedAt: null, timer: null });
  channelStats.set(i, { toggle_count: 0, total_on_ms: 0, last_on_at: null, last_off_at: null });
  safeStates.set(i, false);
}

// --- I2C layer via Sequent 16relind CLI ---
// Uses the `16relind` CLI tool (already installed on the Pi) to control the
// Sixteen SSR HAT. Relay numbering: CLI uses 1-16, our channels are 0-15.

function i2cWrite(channel, value) {
  if (config.DUMMY_MODE) {
    console.log(`[DUMMY] channel ${channel} -> ${value ? 'ON' : 'OFF'}`);
    return;
  }

  const pump = config.PUMPS.find(p => p.id === channel);
  if (!pump) throw new Error(`No pump configured for channel ${channel}`);
  const board = pump.board_index;
  const relay = pump.channel + 1; // CLI expects 1-16
  const state = value ? 1 : 0;
  const cmd = `16relind ${board} write ${relay} ${state}`;

  try {
    execSync(cmd, { timeout: 3000, stdio: 'pipe' });
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString().trim() : err.message;
    console.error(`[I2C] Failed: ${cmd} — ${msg}`);
    throw new Error(`I2C write failed for channel ${channel}: ${msg}`);
  }
}

function i2cReadAll(board) {
  if (config.DUMMY_MODE) return 0;

  try {
    const out = execSync(`16relind ${board} read`, { timeout: 3000, encoding: 'utf8' }).trim();
    return parseInt(out, 10) || 0;
  } catch (err) {
    console.error(`[I2C] Failed to read board ${board}: ${err.message}`);
    return 0;
  }
}

function allOffHardware() {
  if (config.DUMMY_MODE) {
    console.log('[DUMMY] all relays off');
    return;
  }

  const boards = [...new Set(config.PUMPS.map(p => p.board_index))];
  for (const board of boards) {
    try {
      execSync(`16relind ${board} write 0`, { timeout: 3000, stdio: 'pipe' });
    } catch (err) {
      console.error(`[I2C] Failed to clear board ${board}: ${err.message}`);
    }
  }
}

// --- Logging ---

function log(entry) {
  entry.timestamp = new Date().toISOString();
  wateringLog.push(entry);
  if (wateringLog.length > LOG_MAX) wateringLog.shift();
}

// --- Core relay operations ---

function activate(channel) {
  if (channel < 0 || channel >= config.TOTAL_CHANNELS) {
    return { ok: false, error: `Channel ${channel} out of range` };
  }

  const state = channelState.get(channel);

  if (state.on) {
    return { ok: false, error: `Channel ${channel} already active` };
  }

  // Cooldown check
  if (state.activatedAt) {
    const elapsed = Date.now() - state.activatedAt;
    if (elapsed < config.MIN_COOLDOWN_MS) {
      return { ok: false, error: `Channel ${channel} in cooldown (${config.MIN_COOLDOWN_MS - elapsed}ms remaining)` };
    }
  }

  i2cWrite(channel, true);
  state.on = true;
  state.activatedAt = Date.now();

  const stats = channelStats.get(channel);
  stats.toggle_count += 1;
  stats.last_on_at = new Date().toISOString();

  // Safety timeout — force off after MAX_PUMP_DURATION_MS
  state.timer = setTimeout(() => {
    console.warn(`[SAFETY] Channel ${channel} hit max duration — forcing off`);
    deactivate(channel);
    log({ event: 'safety_cutoff', channel });
  }, config.MAX_PUMP_DURATION_MS);

  log({ event: 'on', channel });
  return { ok: true, channel, action: 'on' };
}

function deactivate(channel) {
  if (channel < 0 || channel >= config.TOTAL_CHANNELS) {
    return { ok: false, error: `Channel ${channel} out of range` };
  }

  const state = channelState.get(channel);

  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  if (!state.on) {
    return { ok: true, channel, action: 'off', note: 'already off' };
  }

  const ranMs = Date.now() - state.activatedAt;
  i2cWrite(channel, false);
  state.on = false;

  const offStats = channelStats.get(channel);
  offStats.total_on_ms += ranMs;
  offStats.last_off_at = new Date().toISOString();

  log({ event: 'off', channel, ran_ms: ranMs });
  return { ok: true, channel, action: 'off', ran_ms: ranMs };
}

function pulse(channel, durationMs) {
  if (durationMs > config.MAX_PUMP_DURATION_MS) {
    return { ok: false, error: `Duration ${durationMs}ms exceeds max ${config.MAX_PUMP_DURATION_MS}ms` };
  }
  if (durationMs < 100) {
    return { ok: false, error: 'Duration too short (min 100ms)' };
  }

  const result = activate(channel);
  if (!result.ok) return result;

  // Clear the safety timer and replace with pulse timer
  const state = channelState.get(channel);
  if (state.timer) clearTimeout(state.timer);

  state.timer = setTimeout(() => {
    deactivate(channel);
  }, durationMs);

  log({ event: 'pulse', channel, duration_ms: durationMs });
  return { ok: true, channel, action: 'pulse', duration_ms: durationMs };
}

// --- Dispense by volume ---

function dispense(pumpId, ml) {
  const pump = config.PUMPS.find(p => p.id === pumpId);
  if (!pump) return { ok: false, error: `Pump ${pumpId} not found` };
  if (!pump.enabled) return { ok: false, error: `Pump ${pumpId} is disabled` };
  if (ml <= 0) return { ok: false, error: 'Volume must be positive' };

  const durationMs = Math.round((ml / pump.flow_ml_per_s) * 1000);
  if (durationMs > config.MAX_PUMP_DURATION_MS) {
    return { ok: false, error: `Calculated duration ${durationMs}ms exceeds max — reduce volume or recalibrate` };
  }

  const result = pulse(pump.channel, durationMs);
  if (!result.ok) return result;

  log({ event: 'dispense', pump_id: pumpId, ml, calculated_ms: durationMs });
  return { ok: true, pump_id: pumpId, action: 'dispense', ml, duration_ms: durationMs };
}

// --- Sequence: run multiple pump operations one after another ---

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runSequence(steps) {
  if (sequenceRunning) {
    return { ok: false, error: 'A sequence is already running' };
  }

  sequenceRunning = true;
  sequenceAborted = false;
  sequenceQueue = steps.map((s, i) => ({ ...s, index: i, status: 'pending' }));

  const startedAt = new Date().toISOString();
  log({ event: 'sequence_start', steps: steps.length });

  for (const step of sequenceQueue) {
    if (sequenceAborted) {
      step.status = 'aborted';
      continue;
    }

    const pump = config.PUMPS.find(p => p.id === step.pump_id);
    if (!pump || !pump.enabled) {
      step.status = 'skipped';
      step.error = pump ? 'disabled' : 'not found';
      continue;
    }

    const durationMs = step.ml
      ? Math.round((step.ml / pump.flow_ml_per_s) * 1000)
      : step.duration_ms || 5000;

    if (durationMs > config.MAX_PUMP_DURATION_MS) {
      step.status = 'skipped';
      step.error = 'exceeds max duration';
      continue;
    }

    step.status = 'running';
    step.actual_ms = durationMs;

    const activateResult = activate(pump.channel);
    if (!activateResult.ok) {
      step.status = 'failed';
      step.error = activateResult.error;
      await sleep(config.MIN_COOLDOWN_MS);
      continue;
    }

    await sleep(durationMs);
    deactivate(pump.channel);
    step.status = 'done';

    // Gap between pumps for cooldown and to avoid current spikes
    await sleep(config.MIN_COOLDOWN_MS);
  }

  sequenceRunning = false;
  log({ event: 'sequence_end', aborted: sequenceAborted, steps: sequenceQueue.length });

  const record = {
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    aborted: sequenceAborted,
    steps: sequenceQueue.map(s => ({ ...s })),
  };
  sequenceHistory.push(record);
  if (sequenceHistory.length > SEQUENCE_HISTORY_MAX) sequenceHistory.shift();

  return { ok: true, action: 'sequence_complete', steps: sequenceQueue };
}

function abortSequence() {
  if (!sequenceRunning) return { ok: false, error: 'No sequence running' };
  sequenceAborted = true;
  allOff();
  log({ event: 'sequence_abort' });
  return { ok: true, action: 'sequence_aborted' };
}

function getSequenceStatus() {
  return { running: sequenceRunning, steps: sequenceQueue };
}

// --- Bulk operations ---

function allOff() {
  // Hardware-level all-off first for safety, then update internal state
  allOffHardware();

  const results = [];
  for (let i = 0; i < config.TOTAL_CHANNELS; i++) {
    const state = channelState.get(i);
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.on = false;
    results.push({ ok: true, channel: i, action: 'off' });
  }
  log({ event: 'all_off' });
  return { ok: true, action: 'all_off', channels: results.length };
}

function allOn() {
  const results = [];
  for (let i = 0; i < config.TOTAL_CHANNELS; i++) {
    results.push(activate(i));
  }
  const succeeded = results.filter(r => r.ok).length;
  log({ event: 'all_on', succeeded, total: config.TOTAL_CHANNELS });
  return { ok: true, action: 'all_on', succeeded, total: config.TOTAL_CHANNELS };
}

function getChannelHistory(channel) {
  if (channel < 0 || channel >= config.TOTAL_CHANNELS) return null;
  const stats = channelStats.get(channel);
  const state = channelState.get(channel);
  return {
    channel,
    toggle_count: stats.toggle_count,
    total_on_ms: stats.total_on_ms,
    last_on_at: stats.last_on_at,
    last_off_at: stats.last_off_at,
    currently_on: state.on,
  };
}

function getSequenceHistory(limit) {
  const n = Math.min(limit || 20, SEQUENCE_HISTORY_MAX);
  return sequenceHistory.slice(-n);
}

function getSafeState(channel) {
  if (channel < 0 || channel >= config.TOTAL_CHANNELS) return null;
  return safeStates.get(channel);
}

function setSafeState(channel, value) {
  if (channel < 0 || channel >= config.TOTAL_CHANNELS) return false;
  safeStates.set(channel, Boolean(value));
  return true;
}

function emergencyStop(reason) {
  if (sequenceRunning) {
    sequenceAborted = true;
  }
  allOff();
  log({ event: 'emergency_stop', reason: reason || null });
  return { ok: true, action: 'emergency_stop', reason: reason || null };
}

// --- Status ---

function getStatus() {
  const channels = [];
  for (let i = 0; i < config.TOTAL_CHANNELS; i++) {
    const state = channelState.get(i);
    channels.push({
      channel: i,
      on: state.on,
      active_ms: state.on && state.activatedAt ? Date.now() - state.activatedAt : 0,
    });
  }
  return {
    channels,
    dummy_mode: config.DUMMY_MODE,
    sequence_running: sequenceRunning,
  };
}

function getLog(limit) {
  const n = Math.min(limit || 50, LOG_MAX);
  return wateringLog.slice(-n);
}

module.exports = {
  activate,
  deactivate,
  pulse,
  dispense,
  allOff,
  allOn,
  getStatus,
  getLog,
  getChannelHistory,
  runSequence,
  abortSequence,
  getSequenceStatus,
  getSequenceHistory,
  getSafeState,
  setSafeState,
  emergencyStop,
  i2cReadAll,
};
