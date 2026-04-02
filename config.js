// monsoon relay agent — configuration
// All timing in milliseconds, flow in ml/s

// ---------------------------------------------------------------------------
// HAT CONFIGURATION
// ---------------------------------------------------------------------------
// Each entry is one Sequent Microsystems 16-relay SSR HAT stacked on the Pi.
//
//   address     — I2C address (for reference; the `16relind` CLI uses board_index)
//   board_index — stack position (0-7) passed to `16relind`
//   pump_count  — how many relay channels on this HAT are wired to pumps (1-16)
//
// To add a second HAT, uncomment the second line and set the correct values.
// Pump IDs are assigned sequentially across HATs: HAT-0 gets IDs 0..pump_count-1,
// HAT-1 gets the next block, and so on.
const HATS = [
  { address: 0x20, board_index: 0, pump_count: 14 },
  // { address: 0x21, board_index: 1, pump_count: 16 },
];

// ---------------------------------------------------------------------------
// AUTO-GENERATED PUMP LIST — derived from HATS above, do not edit manually
// ---------------------------------------------------------------------------
const PUMPS = [];
let _pumpId = 0;
for (const hat of HATS) {
  for (let localCh = 0; localCh < hat.pump_count; localCh++) {
    PUMPS.push({
      id: _pumpId,
      board_index: hat.board_index, // which HAT this pump lives on
      channel: localCh,             // local relay channel on that HAT (0-15)
      name: `pump-${String(_pumpId).padStart(2, '0')}`,
      enabled: true,
      flow_ml_per_s: 1.0, // placeholder — calibrate per pump
    });
    _pumpId++;
  }
}

// Total channels tracked = total pumps across all configured HATs
const TOTAL_CHANNELS = PUMPS.length;

// ---------------------------------------------------------------------------
// SAFETY
// ---------------------------------------------------------------------------

// Absolute maximum any single pump can run continuously
const MAX_PUMP_DURATION_MS = 600_000; // 10 minutes

// Minimum gap between consecutive activations of the same pump
const MIN_COOLDOWN_MS = 5_000;

// ---------------------------------------------------------------------------
// WATCHDOG HAT — battery thresholds in mV
// ---------------------------------------------------------------------------
const WATCHDOG_ADDRESS = 0x30;
const BATTERY_LOW_MV = 3700;      // dashboard warning
const BATTERY_CRITICAL_MV = 3600; // initiate safe shutdown
const WATCHDOG_DEFAULT_PERIOD_S = 120;

// ---------------------------------------------------------------------------
// DUMMY MODE
// ---------------------------------------------------------------------------
// Set to true to log relay/watchdog commands instead of sending them to hardware.
// The env var MONSOON_DUMMY=0 overrides this to false (live hardware).
// The env var MONSOON_DUMMY=1 overrides this to true (force dummy).
const DUMMY_MODE_DEFAULT = false;

// ---------------------------------------------------------------------------
// RUNTIME
// ---------------------------------------------------------------------------
module.exports = {
  HATS,
  PUMPS,
  TOTAL_CHANNELS,
  MAX_PUMP_DURATION_MS,
  MIN_COOLDOWN_MS,
  WATCHDOG_ADDRESS,
  BATTERY_LOW_MV,
  BATTERY_CRITICAL_MV,
  WATCHDOG_DEFAULT_PERIOD_S,
  PORT: parseInt(process.env.MONSOON_PORT, 10) || 80,
  DUMMY_MODE: process.env.MONSOON_DUMMY === '0' ? false
            : process.env.MONSOON_DUMMY === '1' ? true
            : DUMMY_MODE_DEFAULT,
};
