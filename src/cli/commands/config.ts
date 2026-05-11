/**
 * `crew-mcp config` — interactive TUI for per-machine settings.
 *
 * Renders the config entries as a checkbox list. Up/down (or j/k)
 * moves the cursor; space toggles; Enter saves and exits; q or Ctrl+C
 * cancels without writing. Designed to grow: add an entry to
 * `buildEntries()` and the list picks it up.
 *
 * The TUI requires a TTY on both stdin and stdout. In non-TTY contexts
 * (CI, piped output) we print the current state + a hint and exit 1,
 * so scripted callers don't hang on a prompt that can't be answered.
 *
 * Hand-rolled raw-mode reader rather than a prompt-library dep — same
 * approach as `interactive-target.ts` for `crew-mcp install`.
 */

import { emitKeypressEvents } from 'node:readline';

import { resolveCrewHome } from '../../utils/crew-home.js';
import {
  type CrewConfig,
  readConfigFile,
  resolveConfigPath,
  writeConfigFile,
} from '../../utils/config-store.js';

interface ConfigEntry {
  readonly key: keyof CrewConfig;
  readonly label: string;
  readonly description: string;
}

/**
 * Order matters — first entry is highlighted on open. Notifications is
 * the first surfaced control because it's the only setting today and
 * the most likely thing a user wants to change.
 */
function buildEntries(): readonly ConfigEntry[] {
  return [
    {
      key: 'notifications',
      label: 'notifications',
      description: 'OS toast when a dispatched run reaches a terminal status',
    },
  ];
}

export interface ConfigCommandOptions {
  /** Test seam — override the TTY assumption. */
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
}

export async function configCommand(opts: ConfigCommandOptions = {}): Promise<number> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const crewHome = resolveCrewHome();
  const configPath = resolveConfigPath(crewHome);
  const entries = buildEntries();
  const current = readConfigFile(crewHome);

  if (!stdin.isTTY || !stdout.isTTY) {
    // Non-interactive surface: print the current state so users in CI
    // can at least see what's configured, plus an actionable hint.
    stdout.write('crew-mcp config (current settings):\n\n');
    for (const entry of entries) {
      const value = current[entry.key];
      stdout.write(`  ${entry.label}: ${value ? 'on' : 'off'}\n`);
    }
    stdout.write(
      `\nInteractive editing requires a TTY. Edit ${configPath} directly,\n`
      + 'or run `crew-mcp config` in a real terminal.\n',
    );
    return 1;
  }

  const state: { -readonly [K in keyof CrewConfig]: CrewConfig[K] } = { ...current };
  const result = await driveTui({ stdin, stdout, entries, state });

  if (result === 'cancelled') {
    stdout.write('\ncrew-mcp config: cancelled (no changes written).\n');
    return 0;
  }

  // Only write if something actually changed — avoids touching the
  // file mtime on a no-op save.
  if (!sameConfig(current, state)) {
    writeConfigFile(crewHome, state);
    stdout.write(`\ncrew-mcp config: saved to ${configPath}\n`);
  } else {
    stdout.write('\ncrew-mcp config: no changes.\n');
  }
  return 0;
}

function sameConfig(a: CrewConfig, b: CrewConfig): boolean {
  return a.notifications === b.notifications;
}

interface TuiArgs {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly entries: readonly ConfigEntry[];
  readonly state: { -readonly [K in keyof CrewConfig]: CrewConfig[K] };
}

type TuiResult = 'saved' | 'cancelled';

function driveTui(args: TuiArgs): Promise<TuiResult> {
  const { stdin, stdout, entries, state } = args;
  let cursor = 0;
  let renderedLines = 0;

  // Clip each line to the terminal width so a narrow terminal can't
  // wrap a description and break the cursor-up-by-N redraw math.
  // `stdout.columns` may be undefined when not on a real TTY; we
  // already guard the non-TTY case at the call site, but keep a
  // sensible fallback. Subtract 1 to leave a column for the cursor
  // and avoid edge-case wrap on some terminals when filling the row.
  const clip = (line: string): string => {
    const cols = stdout.columns ?? 80;
    const limit = Math.max(10, cols - 1);
    return line.length <= limit ? line : line.slice(0, limit);
  };

  const render = (): void => {
    if (renderedLines > 0) {
      // Move up to the top of the previous frame and clear downward.
      stdout.write(`\x1b[${renderedLines}A`);
      stdout.write('\x1b[0J');
    }
    const lines: string[] = [];
    lines.push('crew-mcp config — toggle settings');
    lines.push('');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const value = state[entry.key];
      const checkbox = value ? '[x]' : '[ ]';
      const pointer = i === cursor ? '>' : ' ';
      const label = entry.label.padEnd(14);
      lines.push(`${pointer} ${checkbox} ${label}  ${entry.description}`);
    }
    lines.push('');
    lines.push('↑/↓ or j/k: move    space: toggle    enter: save    q / esc: cancel');
    for (const line of lines) stdout.write(`${clip(line)}\n`);
    renderedLines = lines.length;
  };

  return new Promise<TuiResult>((resolve) => {
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    let cleanedUp = false;

    // Single idempotent teardown path: any exit (normal key, error,
    // SIGINT/SIGTERM, terminal disconnect) must restore raw mode and
    // detach listeners exactly once. Without this, an exception
    // partway through render or an external signal can leave the
    // user's shell in raw mode and unusable.
    const cleanup = (result: TuiResult): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      stdin.removeListener('keypress', onKeypress);
      stdout.removeListener('resize', onResize);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.off('uncaughtException', onFatal);
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        // Best-effort — if even restoring raw mode fails the process
        // is in trouble already; nothing useful to do here.
      }
      stdin.pause();
      resolve(result);
    };

    const onSignal = (): void => cleanup('cancelled');
    const onFatal = (err: Error): void => {
      cleanup('cancelled');
      // Re-throw on the next tick so Node's default unhandled-error
      // path still surfaces the crash to the user. The cleanup above
      // restores the terminal first so the error message is readable.
      setImmediate(() => {
        throw err;
      });
    };

    const onResize = (): void => {
      // On resize, force a full redraw with no upward seek — the
      // previous frame's row count is no longer trustworthy after
      // the terminal reflows.
      renderedLines = 0;
      render();
    };

    const onKeypress = (
      _str: string | undefined,
      key: { name?: string; ctrl?: boolean; sequence?: string } | undefined,
    ): void => {
      if (!key) return;
      try {
        if (key.ctrl && key.name === 'c') {
          cleanup('cancelled');
          return;
        }
        switch (key.name) {
          case 'up':
          case 'k':
            cursor = (cursor - 1 + entries.length) % entries.length;
            render();
            return;
          case 'down':
          case 'j':
            cursor = (cursor + 1) % entries.length;
            render();
            return;
          case 'space': {
            const entry = entries[cursor];
            state[entry.key] = !state[entry.key];
            render();
            return;
          }
          case 'return':
            cleanup('saved');
            return;
          case 'q':
          case 'escape':
            cleanup('cancelled');
            return;
          default:
            return;
        }
      } catch (err) {
        onFatal(err instanceof Error ? err : new Error(String(err)));
      }
    };

    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('keypress', onKeypress);
      stdout.on('resize', onResize);
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      process.on('uncaughtException', onFatal);
      render();
    } catch (err) {
      onFatal(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
