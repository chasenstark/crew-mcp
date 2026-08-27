import type { KeyResult, Screen, TuiKey } from './screen.js';

export interface PrWatchLimitsScreenState {
  maxActionableWakes: number;
  maxActionRounds: number;
  maxWatchAgeDays: number;
}

const COUNT_PRESETS: readonly number[] = [1, 2, 3, 5, 10, 15, 20, 25, 50, 100];
const AGE_PRESETS: readonly number[] = [-1, 1, 3, 7, 14, 30, 60, 90, 180, 365];
type Row = 'wakes' | 'rounds' | 'age' | 'back';
const ROWS: readonly Row[] = ['wakes', 'rounds', 'age', 'back'];

function nextPreset(current: number, presets: readonly number[]): number {
  const index = presets.indexOf(current);
  if (index < 0) return presets.find((value) => value > current) ?? presets[0];
  return presets[(index + 1) % presets.length];
}

/** Configure per-watch budgets and the absolute nonterminal age deadline. */
export class PrWatchLimitsScreen implements Screen {
  private cursor = 0;

  constructor(private readonly state: PrWatchLimitsScreenState) {}

  render(): string[] {
    const lines = [
      'PR-watch limits',
      '',
      'New watches snapshot these values; changing them does not rewrite existing watches.',
      '',
    ];
    for (let index = 0; index < ROWS.length; index++) {
      const pointer = index === this.cursor ? '>' : ' ';
      switch (ROWS[index]) {
        case 'wakes':
          lines.push(`${pointer} actionable wake budget: ${this.state.maxActionableWakes}   (space cycles)`);
          break;
        case 'rounds':
          lines.push(`${pointer} action round budget:    ${this.state.maxActionRounds}   (space cycles)`);
          break;
        case 'age':
          lines.push(`${pointer} maximum watch age:     ${this.state.maxWatchAgeDays < 0 ? 'off' : `${this.state.maxWatchAgeDays}d`}   (space cycles)`);
          break;
        case 'back':
          lines.push(`${pointer} back`);
          break;
      }
    }
    lines.push('');
    lines.push('↑/↓ or j/k: move    space: change    enter: save    q/esc: back');
    lines.push('An age of off disables automatic expiry for newly created watches.');
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
        return this.activate();
      case 'return':
      case 'enter':
        return 'save';
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
      case 'wakes':
        this.state.maxActionableWakes = nextPreset(this.state.maxActionableWakes, COUNT_PRESETS);
        return 'continue';
      case 'rounds':
        this.state.maxActionRounds = nextPreset(this.state.maxActionRounds, COUNT_PRESETS);
        return 'continue';
      case 'age':
        this.state.maxWatchAgeDays = nextPreset(this.state.maxWatchAgeDays, AGE_PRESETS);
        return 'continue';
      case 'back':
        return 'pop';
    }
  }
}
