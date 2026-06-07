import type { KeyResult, Screen, TuiKey } from './screen.js';

/**
 * Mutable slice of `CrewConfig.cleanup` the submenu edits in place. The
 * parent `configCommand` persists it (and detects changes) after the TUI
 * exits.
 */
export interface CleanupScreenState {
  worktreeTtlDays: number;
  runDirTtlDays: number;
  criteriaSetTtlDays: number;
}

/** Day presets the TTL rows cycle through (-1 renders as "off"). */
const PRESETS: readonly number[] = [-1, 0, 1, 3, 7, 14, 30, 60, 90];

type Row = 'worktree' | 'rundir' | 'criteria' | 'preview' | 'run' | 'back';
const ROWS: readonly Row[] = ['worktree', 'rundir', 'criteria', 'preview', 'run', 'back'];

function fmtDays(days: number): string {
  return days < 0 ? 'off' : `${days}d`;
}

function nextPreset(current: number): number {
  const idx = PRESETS.indexOf(current);
  if (idx < 0) return PRESETS[0];
  return PRESETS[(idx + 1) % PRESETS.length];
}

/**
 * Cleanup & retention submenu. Two TTL rows cycle through day presets on
 * space/enter; "Run cleanup now" / "Preview" record the requested action
 * and return `save` so the parent can persist settings and then run the
 * GC after the raw-mode TUI has torn down (cleanup is async and can't run
 * inside the synchronous key handler).
 */
export class CleanupScreen implements Screen {
  private cursor = 0;
  /** Set when the user picks an action row; read by `configCommand`. */
  public requested: 'dry' | 'run' | undefined;

  constructor(private readonly state: CleanupScreenState) {}

  render(): string[] {
    const lines: string[] = [];
    lines.push('Cleanup & retention');
    lines.push('');
    lines.push('Garbage-collect terminal runs under ~/.crew/runs. Worktrees are');
    lines.push('reclaimed first (branch kept unless merged); run-dirs deleted later.');
    lines.push('');
    for (let i = 0; i < ROWS.length; i++) {
      const pointer = i === this.cursor ? '>' : ' ';
      switch (ROWS[i]) {
        case 'worktree':
          lines.push(`${pointer} worktree TTL:  ${fmtDays(this.state.worktreeTtlDays)}   (space cycles)`);
          break;
        case 'rundir':
          lines.push(`${pointer} run-dir TTL:   ${fmtDays(this.state.runDirTtlDays)}   (space cycles)`);
          break;
        case 'criteria':
          lines.push(`${pointer} criteria TTL:  ${fmtDays(this.state.criteriaSetTtlDays)}   (space cycles)`);
          break;
        case 'preview':
          lines.push(`${pointer} Preview cleanup now (dry run)`);
          break;
        case 'run':
          lines.push(`${pointer} Run cleanup now`);
          break;
        case 'back':
          lines.push(`${pointer} back`);
          break;
      }
    }
    lines.push('');
    lines.push('↑/↓ or j/k: move    space/enter: select    q/esc: back');
    lines.push('(-1 / "off" disables a window. Env CREW_*_TTL_DAYS overrides config.)');
    return lines;
  }

  onKey(key: TuiKey): KeyResult {
    if (key.ctrl && key.name === 'c') return 'cancel';
    switch (key.name) {
      case 'up':
      case 'k':
        this.move(-1);
        return 'continue';
      case 'down':
      case 'j':
        this.move(1);
        return 'continue';
      case 'space':
      case 'return':
      case 'enter':
        return this.activate();
      case 'q':
      case 'escape':
        return 'pop';
      default:
        return 'continue';
    }
  }

  private move(delta: number): void {
    this.cursor = (this.cursor + delta + ROWS.length) % ROWS.length;
  }

  private activate(): KeyResult {
    switch (ROWS[this.cursor]) {
      case 'worktree':
        this.state.worktreeTtlDays = nextPreset(this.state.worktreeTtlDays);
        return 'continue';
      case 'rundir':
        this.state.runDirTtlDays = nextPreset(this.state.runDirTtlDays);
        return 'continue';
      case 'criteria':
        this.state.criteriaSetTtlDays = nextPreset(this.state.criteriaSetTtlDays);
        return 'continue';
      case 'preview':
        this.requested = 'dry';
        return 'save';
      case 'run':
        this.requested = 'run';
        return 'save';
      case 'back':
        return 'pop';
    }
  }
}
