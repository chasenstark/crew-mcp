import { join } from 'node:path';

export const CODEX_NATIVE_REVIEWER_HOOK_EVENT = 'SubagentStop';
export const CODEX_NATIVE_REVIEWER_HOOK_TIMEOUT_SECONDS = 30;

export function codexGlobalHooksPath(home: string): string {
  return join(home, '.codex', 'hooks.json');
}

export function codexProjectHooksPath(repoRoot: string): string {
  return join(repoRoot, '.codex', 'hooks.json');
}

export function mergeCodexNativeReviewerHook(
  existing: string,
  command: string,
): string {
  const root = parseHooksRoot(existing);
  removeCrewHooks(root);
  const hooks = ensureObject(root, 'hooks');
  const entries = ensureArray(hooks, CODEX_NATIVE_REVIEWER_HOOK_EVENT);
  entries.push({
    matcher: '.*',
    hooks: [{
      type: 'command',
      command,
      timeout: CODEX_NATIVE_REVIEWER_HOOK_TIMEOUT_SECONDS,
    }],
  });
  return `${JSON.stringify(root, null, 2)}\n`;
}

export function removeCodexNativeReviewerHook(existing: string): string {
  if (existing.trim().length === 0) return existing;
  const root = parseHooksRoot(existing);
  const changed = removeCrewHooks(root);
  return changed ? `${JSON.stringify(root, null, 2)}\n` : existing;
}

export function hasCodexNativeReviewerHook(
  existing: string,
  expectedCommand?: string,
): boolean {
  if (existing.trim().length === 0) return false;
  const root = parseHooksRoot(existing);
  const hooks = root.hooks;
  if (!isObject(hooks)) return false;
  const entries = hooks[CODEX_NATIVE_REVIEWER_HOOK_EVENT];
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => {
    if (!isObject(entry) || !Array.isArray(entry.hooks)) return false;
    return entry.hooks.some((hook) => (
      isObject(hook)
      && hook.type === 'command'
      && typeof hook.command === 'string'
      && (expectedCommand === undefined
        ? isCrewNativeReviewerHookCommand(hook.command)
        : hook.command === expectedCommand)
    ));
  });
}

export function isCrewNativeReviewerHookCommand(command: string): boolean {
  return /(?:^|[\\/\s'"&])crew-native-reviewer-hook(?:\.cmd)?(?=$|[\s'"])/i.test(command);
}

function removeCrewHooks(root: Record<string, unknown>): boolean {
  const hooks = root.hooks;
  if (!isObject(hooks)) return false;
  const entries = hooks[CODEX_NATIVE_REVIEWER_HOOK_EVENT];
  if (!Array.isArray(entries)) return false;

  let changed = false;
  const nextEntries: unknown[] = [];
  for (const entry of entries) {
    if (!isObject(entry) || !Array.isArray(entry.hooks)) {
      nextEntries.push(entry);
      continue;
    }
    const nextHooks = entry.hooks.filter((hook) => {
      const owned = isObject(hook)
        && hook.type === 'command'
        && typeof hook.command === 'string'
        && isCrewNativeReviewerHookCommand(hook.command);
      if (owned) changed = true;
      return !owned;
    });
    if (nextHooks.length > 0) {
      nextEntries.push({ ...entry, hooks: nextHooks });
    } else if (entry.hooks.length === 0) {
      nextEntries.push(entry);
    }
  }
  if (!changed) return false;
  if (nextEntries.length > 0) {
    hooks[CODEX_NATIVE_REVIEWER_HOOK_EVENT] = nextEntries;
  } else {
    delete hooks[CODEX_NATIVE_REVIEWER_HOOK_EVENT];
  }
  if (Object.keys(hooks).length === 0) delete root.hooks;
  return true;
}

function parseHooksRoot(existing: string): Record<string, unknown> {
  if (existing.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch (error) {
    throw new Error(
      `Codex hooks file is invalid JSON; refusing to overwrite it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isObject(parsed)) {
    throw new Error('Codex hooks file must contain a JSON object; refusing to overwrite it');
  }
  if (parsed.hooks !== undefined && !isObject(parsed.hooks)) {
    throw new Error('Codex hooks field must be an object; refusing to overwrite it');
  }
  const eventEntries = isObject(parsed.hooks)
    ? parsed.hooks[CODEX_NATIVE_REVIEWER_HOOK_EVENT]
    : undefined;
  if (eventEntries !== undefined && !Array.isArray(eventEntries)) {
    throw new Error('Codex hooks.SubagentStop must be an array; refusing to overwrite it');
  }
  return parsed;
}

function ensureObject(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = root[key];
  if (current === undefined) {
    const created: Record<string, unknown> = {};
    root[key] = created;
    return created;
  }
  if (!isObject(current)) {
    throw new Error(`Codex hooks.${key} must be an object; refusing to overwrite it`);
  }
  return current;
}

function ensureArray(root: Record<string, unknown>, key: string): unknown[] {
  const current = root[key];
  if (current === undefined) {
    const created: unknown[] = [];
    root[key] = created;
    return created;
  }
  if (!Array.isArray(current)) {
    throw new Error(`Codex hooks.${key} must be an array; refusing to overwrite it`);
  }
  return current;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
