import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_PATH = resolve(HERE, '../../dist/index.js');

/**
 * Each MCP tool description must appear in the bundled `dist/index.js`.
 * The published package ships from dist, so a stale dist serves older
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
describe('dist/index.js parity with current src descriptions', () => {
  if (!existsSync(DIST_PATH)) {
    it.skip('dist/index.js not built — run `npm run build` to enable parity checks', () => {});
    return;
  }

  const dist = readFileSync(DIST_PATH, 'utf-8');

  it.each([
    ['run_agent', 'Delegate a task to a subagent in an isolated worktree'],
    ['continue_run', 'Resume a run with a new prompt. Same agent, same worktree.'],
    ['merge_run', 'Pass commit_title (and optional commit_body) for the merge commit'],
    ['get_run_status', 'Always poll after run_agent / continue_run'],
    ['list_agents', 'Return the current agent inventory'],
    ['cancel_run', 'Abort an in-flight run. The run ends with status'],
    ['discard_run', 'without merging. Idempotent.'],
  ] as const)('dist contains current %s description anchor', (_name, anchor) => {
    expect(dist).toContain(anchor);
  });
});
