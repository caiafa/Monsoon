---
name: monsoon-patterns
description: Coding patterns for the Monsoon Raspberry Pi irrigation relay agent — Express.js HTTP-to-I2C bridge with safety limits, sequencing, and hardware abstraction
version: 1.0.0
source: local-git-analysis
analyzed_commits: 1
---

# Monsoon Patterns

## Commit Conventions

This project uses **conventional commits**:
- `feat:` — New features
- `fix:` — Bug fixes
- `chore:` — Maintenance tasks
- `docs:` — Documentation updates
- `refactor:` — Code restructuring
- `test:` — Test additions/changes

## Code Architecture

```
/opt/monsoon/              # Deployment location on Raspberry Pi
├── config.js              # All constants, safety limits, pump definitions
├── relay.js               # Hardware abstraction — I2C, state, sequences
├── server.js              # Express HTTP API — thin bridge to relay.js
├── package.json           # Single dependency: express
├── MONSOON_HANDOVER.md    # Infrastructure handover doc
└── README.md              # Deployment & API reference
```

### Design Principles

- **Flat file structure** — no `src/` nesting; 3 core files with clear responsibilities
- **Thin bridge pattern** — `server.js` validates HTTP input then delegates to `relay.js`; no business logic in routes
- **Hardware abstraction** — all I2C interaction isolated in `relay.js`; rest of codebase unaware of hardware details
- **Dummy mode** — `MONSOON_DUMMY !== '0'` enables console-only operation for development; default is dummy
- **CLI over library** — uses installed `16relind` and `wdt` CLI tools via `execSync` rather than low-level `i2c-bus` register writes; simpler, proven, and the relay operation frequency (~5s cooldown) makes execSync overhead irrelevant

### Safety-First Patterns

Every relay operation enforces:
1. **Channel range validation** — reject out-of-bounds immediately
2. **Cooldown enforcement** — `MIN_COOLDOWN_MS` (5s) between activations of the same channel
3. **Max duration hard cap** — `MAX_PUMP_DURATION_MS` (120s) auto-cutoff via setTimeout
4. **Startup all-off** — `relay.allOff()` called on boot to ensure clean state
5. **Graceful shutdown** — SIGTERM/SIGINT handlers turn all relays off before exit
6. **Emergency stop** — `POST /relay/all-off` sends hardware-level all-off before clearing internal state

### Module Responsibilities

| File | Responsibility | Exports |
|------|---------------|---------|
| `config.js` | Constants, pump definitions, env var parsing | Plain object |
| `relay.js` | I2C writes, channel state, safety timers, sequences, logging | `activate`, `deactivate`, `pulse`, `dispense`, `allOff`, `runSequence`, etc. |
| `server.js` | Express routes, input validation, CORS, system info endpoints | Nothing (entry point) |

## Workflows

### Adding a New Pump

1. Increase pump count in `config.js` `PUMPS` array (or add explicit entry)
2. Map to the correct SSR HAT channel (0-15 per board)
3. Calibrate `flow_ml_per_s` via `PUT /pumps/:id`
4. Test with `POST /relay/:id/pulse` in dummy mode first

### Adding a New API Endpoint

1. Add Express route in `server.js` under the appropriate section comment block
2. Validate all input parameters inline (parseInt, parseFloat, isNaN checks)
3. Delegate to `relay.js` for any hardware interaction
4. Return `{ ok: true/false, ... }` envelope — error details in `error` field

### Deploying Changes

```bash
# From dev machine
scp config.js relay.js server.js package.json root@192.168.3.70:/opt/monsoon/
ssh root@192.168.3.70 "cd /opt/monsoon && npm install --production && systemctl restart monsoon"
```

### Verifying Hardware

```bash
# On the Pi
16relind 0 test            # Cycle all 16 relays
16relind 0 rwr 1 1         # Relay 1 on
16relind 0 rwr 1 0         # Relay 1 off
wdt -r                     # Feed watchdog
wdt -g vb                  # Battery voltage (mV)
```

## API Response Pattern

All endpoints return a consistent envelope:

```json
{ "ok": true, "channel": 0, "action": "on" }
{ "ok": false, "error": "Channel 0 in cooldown (3200ms remaining)" }
```

- `ok` is always present
- Success responses include action-specific fields
- Error responses include `error` string with human-readable detail
- No nested error objects or error codes — keep it flat

## Configuration Pattern

- All tunables in `config.js` as plain `const` exports
- Environment variables for deployment overrides only: `MONSOON_PORT`, `MONSOON_DUMMY`
- Pump config is runtime-mutable via API (`PUT /pumps/:id`) but not persisted to disk
- I2C addresses in `RELAY_BOARD_ADDRESSES` array to support future stacked HATs

## Error Handling Pattern

- **I2C errors** — caught in `i2cWrite`, logged with `[I2C]` prefix, re-thrown as descriptive Error
- **Route errors** — validated inline, return 400 with `{ ok: false, error }`, never throw
- **System commands** — wrapped in try/catch with `stdio: 'pipe'` and 3s timeout; stderr extracted for error messages
- **Never silently fail** — all catch blocks log before returning

## Testing Patterns

- No test framework currently — project relies on dummy mode for development testing
- Dummy mode (`MONSOON_DUMMY=1`) allows full API exercise without hardware
- Manual hardware testing via `16relind` CLI and `curl` against the running service
- Future: add unit tests for `relay.js` state management (pure logic, mockable I2C layer)

## Infrastructure Notes

- **Target**: Raspberry Pi 3B+ running Pi OS Trixie (Debian testing)
- **Service**: systemd unit at `/etc/systemd/system/monsoon.service`, runs as root (required for port 80 + I2C)
- **Network**: Static IP `192.168.3.70`, controlled by dashboard on `192.168.3.50` (downpour)
- **Watchdog**: Hardware watchdog HAT with 120s timeout — cron feeds every minute via `wdt -r`
- **No containers**: Pure systemd deployment, no Docker/PM2 on the relay agent
