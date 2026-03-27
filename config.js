// monsoon relay agent — configuration
// All timing in milliseconds, flow in ml/s

const RELAY_BOARD_ADDRESSES = [0x20]; // I2C addresses for stacked SSR HATs — add more as needed
const TOTAL_CHANNELS = 16;

// Safety: absolute maximum any single pump can run continuously
const MAX_PUMP_DURATION_MS = 120_000; // 2 minutes

// Safety: minimum gap between consecutive activations of the same pump
const MIN_COOLDOWN_MS = 5_000;

// Per-pump config. Channels 0-13 mapped to 14 pumps.
// flow_ml_per_s will be calibrated per-pump once hardware arrives.
const PUMPS = Array.from({ length: 14 }, (_, i) => ({
  id: i,
  channel: i,
  name: `pump-${String(i).padStart(2, '0')}`,
  enabled: true,
  flow_ml_per_s: 1.0, // placeholder — calibrate per pump
}));

// Watchdog HAT — battery thresholds in mV
const WATCHDOG_ADDRESS = 0x30;
const BATTERY_LOW_MV = 3700;      // dashboard warning
const BATTERY_CRITICAL_MV = 3600; // initiate safe shutdown
const WATCHDOG_DEFAULT_PERIOD_S = 120;

module.exports = {
  RELAY_BOARD_ADDRESSES,
  TOTAL_CHANNELS,
  MAX_PUMP_DURATION_MS,
  MIN_COOLDOWN_MS,
  PUMPS,
  WATCHDOG_ADDRESS,
  BATTERY_LOW_MV,
  BATTERY_CRITICAL_MV,
  WATCHDOG_DEFAULT_PERIOD_S,
  PORT: parseInt(process.env.MONSOON_PORT, 10) || 80,
  DUMMY_MODE: process.env.MONSOON_DUMMY !== '0', // dummy by default until hardware is wired
};
