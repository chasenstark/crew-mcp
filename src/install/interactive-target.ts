/**
 * Interactive target picker for `crew install` (no `--target` flag).
 *
 * Prints a numbered list of registered hosts, marks detected ones with
 * a check, and asks for either comma-separated indices, the shorthand
 * `a` (= all detected), or blank to cancel.
 *
 * Hand-rolled with `node:readline` to avoid adding a prompt-library
 * dependency for what's essentially a one-shot 3-option multi-select.
 * The PromptIO seam lets tests inject canned answers without driving
 * a real TTY.
 *
 * The full TUI of v0.1 was deliberately retired in M0; this is a
 * single install-time prompt, not an ongoing interactive loop. Same
 * shape as a typical CLI install wizard.
 */

import { createInterface } from 'node:readline';

import type { HostId } from './hosts/index.js';

export interface DetectedHost {
  readonly id: HostId;
  readonly displayName: string;
  /** Whether the host CLI binary was detected on PATH. */
  readonly installed: boolean;
  /** Version string from `<host> --version` if detected; absent otherwise. */
  readonly version?: string;
}

export interface PromptIO {
  /** Write a line of output (no implicit newline; caller appends if wanted). */
  write(line: string): void;
  /** Read one line from the user, displayed after `prompt`. */
  question(prompt: string): Promise<string>;
}

export interface SelectTargetsArgs {
  readonly hosts: readonly DetectedHost[];
  /** Override IO for tests; defaults to stdout/stdin readline. */
  readonly io?: PromptIO;
  /**
   * Cap the user's correction loop. After this many invalid inputs in
   * a row we bail with an empty selection (treated as cancel). Prevents
   * an unattended terminal from looping forever.
   */
  readonly maxRetries?: number;
}

const DEFAULT_MAX_RETRIES = 3;

/**
 * Drive the interactive target picker. Returns the host ids the user
 * selected (in registration order). Empty array means the user
 * cancelled or exhausted retries — caller should treat as "do nothing,
 * exit cleanly."
 *
 * Throws only on programmer error (zero hosts passed in); never on
 * bad user input — that's loop-and-retry.
 */
export async function selectTargets(args: SelectTargetsArgs): Promise<HostId[]> {
  const { hosts } = args;
  if (hosts.length === 0) {
    throw new Error('selectTargets called with no hosts to choose from.');
  }
  const io = args.io ?? defaultReadlineIO();
  const maxRetries = args.maxRetries ?? DEFAULT_MAX_RETRIES;

  try {
    renderHostList(hosts, io);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const raw = (await io.question('> ')).trim();
      if (raw.length === 0) {
        io.write('crew install: cancelled (no targets selected).\n');
        return [];
      }
      const result = parseSelection(raw, hosts);
      if (result.kind === 'ok') return result.targets;
      if (attempt === maxRetries) {
        io.write(`crew install: ${result.error} — giving up after ${maxRetries + 1} attempts.\n`);
        return [];
      }
      io.write(`crew install: ${result.error} Try again, or blank to cancel.\n`);
    }
    return [];
  } finally {
    if ('close' in io && typeof (io as { close: unknown }).close === 'function') {
      (io as { close: () => void }).close();
    }
  }
}

function renderHostList(hosts: readonly DetectedHost[], io: PromptIO): void {
  io.write('crew install: choose targets\n\n');
  for (let i = 0; i < hosts.length; i++) {
    const h = hosts[i];
    const mark = h.installed ? '✓' : ' ';
    const status = h.installed
      ? `detected${h.version ? ` (${h.version})` : ''}`
      : 'not on PATH';
    // Pad displayName to a consistent column for readable status alignment.
    const padded = h.displayName.padEnd(13);
    io.write(`  ${i + 1}) [${mark}] ${padded} ${status}\n`);
  }
  io.write('\nEnter comma-separated numbers, "a" for all detected, or blank to cancel.\n');
}

type ParseResult =
  | { kind: 'ok'; targets: HostId[] }
  | { kind: 'error'; error: string };

/**
 * Parse user input. Accepted forms:
 *   - "1"             → single index
 *   - "1,3"           → multiple indices (comma-separated; whitespace tolerated)
 *   - "a" / "all"     → every detected host
 * Indices are 1-based. Out-of-range or non-numeric → error.
 * Duplicates are deduplicated; original order preserved.
 */
export function parseSelection(
  raw: string,
  hosts: readonly DetectedHost[],
): ParseResult {
  const lower = raw.toLowerCase();
  if (lower === 'a' || lower === 'all') {
    const detected = hosts.filter((h) => h.installed).map((h) => h.id);
    if (detected.length === 0) {
      return { kind: 'error', error: 'no host CLIs detected on PATH;' };
    }
    return { kind: 'ok', targets: detected };
  }
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    return { kind: 'error', error: 'no selection;' };
  }
  const seen = new Set<HostId>();
  const out: HostId[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > hosts.length) {
      return {
        kind: 'error',
        error: `"${part}" is not a valid choice (expected 1..${hosts.length}, "a", or blank);`,
      };
    }
    const id = hosts[n - 1].id;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return { kind: 'ok', targets: out };
}

/**
 * Default readline-backed PromptIO. Closed by the finally block in
 * `selectTargets` so the process can exit cleanly after the prompt.
 */
function defaultReadlineIO(): PromptIO & { close(): void } {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return {
    write(line) {
      process.stdout.write(line);
    },
    question(prompt) {
      return new Promise((resolve) => rl.question(prompt, resolve));
    },
    close() {
      rl.close();
    },
  };
}
