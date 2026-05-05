/**
 * `crew agents edit` — open the per-machine agent prefs file in
 * `$EDITOR` (or `$VISUAL`, falling back to `vi`). Creates the file
 * with adapter defaults first if it doesn't exist, so editing for the
 * first time gives the user a populated starting point.
 *
 * Production-only command — no test seam needed because it spawns the
 * editor on a real terminal. Tests cover the underlying store; the
 * editor invocation is glue.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { createBuiltinRegistry } from '../../adapters/registry.js';
import {
  resolveAgentPrefsPath,
  seedAgentPrefsFile,
  type AgentPrefsMap,
} from '../../agent-prefs/store.js';
import { resolveCrewHome } from '../../utils/crew-home.js';
import { logger } from '../../utils/logger.js';

export async function agentsEditCommand(): Promise<number> {
  const crewHome = resolveCrewHome();
  const path = resolveAgentPrefsPath(crewHome);

  if (!existsSync(path)) {
    seedAgentPrefsFile(crewHome, collectAdapterDefaults());
    logger.info(`crew agents edit: created ${path} with adapter defaults`);
  }

  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  // Edit-mode commands like `vi` need to attach to the user's TTY for
  // both input + output, so inherit stdio rather than capturing.
  const child = spawn(editor, [path], { stdio: 'inherit' });
  return new Promise<number>((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      logger.error(`crew agents edit: failed to launch editor "${editor}" — ${err.message}`);
      resolve(1);
    });
  });
}

function collectAdapterDefaults(): AgentPrefsMap {
  const registry = createBuiltinRegistry();
  const defaults: AgentPrefsMap = {};
  for (const adapter of registry.listAvailable()) {
    defaults[adapter.name] = {
      strengths: [...adapter.strengths],
      ...(adapter.defaultEffort ? { effort: adapter.defaultEffort } : {}),
    };
  }
  return defaults;
}
