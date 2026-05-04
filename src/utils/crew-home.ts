import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CREW_HOME_ENV = 'CREW_HOME';

/**
 * Resolve the per-user crew home directory. All persistent crew state
 * (run-state, worktrees, install manifest) lives under this path so the
 * host repo's working tree stays untouched.
 *
 * Resolution order:
 *   1. `$CREW_HOME` if set + non-empty (test seam + escape hatch for
 *      pathological CI where `$HOME` isn't writable).
 *   2. `<homedir()>/.crew` — matches the location M3 already established
 *      for `install.json`.
 *
 * Side effect: ensures the directory exists (`mkdirSync` recursive).
 * Cheap + idempotent; safe to call multiple times per process.
 */
export function resolveCrewHome(): string {
  const override = process.env[CREW_HOME_ENV];
  const home = override && override.length > 0 ? override : join(homedir(), '.crew');
  mkdirSync(home, { recursive: true });
  return home;
}
