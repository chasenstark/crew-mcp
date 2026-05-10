import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(HERE, '../../dist');
const DIST_ENTRY_PATH = resolve(DIST_DIR, 'index.js');

/**
 * Each MCP tool description must appear in the built `dist/*.js` files.
 * The published package ships from dist, so stale output serves older
 * heavier descriptions to captains even when src has been trimmed —
 * exactly the regression this check guards against (April 2026 audit
 * found dist drifting behind src descriptions).
 *
 * Anchored on ASCII-only substrings rather than full text because tsup
 * escapes non-ASCII characters (em-dash, etc.) as \uXXXX in the bundle,
 * breaking exact-string match against source literals. Anchors are
 * unique to the current trim — if a description is rewritten beyond
 * the anchor, update both src and the anchor here in the same change.
 *
 * Skipped when dist/index.js doesn't exist so local dev that hasn't
 * built doesn't fail unrelated runs. CI is expected to invoke
 * `npm run build` before `vitest`, and `prepublishOnly` already
 * rebuilds dist before publish — this test catches the case where
 * neither happens.
 */
describe('dist JS parity with current src descriptions', () => {
  if (!existsSync(DIST_ENTRY_PATH)) {
    it.skip('dist/index.js not built — run `npm run build` to enable parity checks', () => {});
    return;
  }

  const dist = readdirSync(DIST_DIR)
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(resolve(DIST_DIR, name), 'utf-8'))
    .join('\n');

  it.each([
    ['run_agent', 'Start a new subagent run for a bounded task'],
    ['continue_run', 'Resume an existing run with a new prompt'],
    ['merge_run', "Merge a completed run's worktree into the host HEAD"],
    ['get_run_status', "Read a run's current status by run_id"],
    ['list_agents', 'List configured agents before dispatching'],
    ['cancel_run', 'Abort an in-flight run by run_id'],
    ['discard_run', 'Mark a run discarded and remove its owned worktree'],
  ] as const)('dist contains current %s description anchor', (_name, anchor) => {
    expect(dist).toContain(anchor);
  });
});
