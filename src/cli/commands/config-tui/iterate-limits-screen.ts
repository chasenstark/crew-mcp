import type { KeyResult, Screen, TuiKey } from './screen.js';

export interface IterateLimitsScreenState {
  maxRoundsPerEpoch: number;
  maxTotalRounds: number;
  checkInMinutes: number;
}

const PRESETS: readonly number[] = [1, 2, 3, 5, 7, 9, 10, 12, 15, 20, 25, 30, 50];
/** -1 = check-ins off (terminal-only watchers). */
const CHECK_IN_PRESETS: readonly number[] = [5, 10, 15, 20, 30, 60, -1];
type Row = 'epoch' | 'total' | 'checkin' | 'back';
const ROWS: readonly Row[] = ['epoch', 'total', 'checkin', 'back'];

function nextPreset(current: number, minimum = 1): number {
  const eligible = PRESETS.filter((value) => value >= minimum);
  const index = eligible.indexOf(current);
  if (index < 0) return eligible.find((value) => value > current) ?? minimum;
  return eligible[(index + 1) % eligible.length];
}

function nextCheckInPreset(current: number): number {
  const index = CHECK_IN_PRESETS.indexOf(current);
  if (index < 0) {
    return CHECK_IN_PRESETS.find((value) => value > current && value !== -1)
      ?? CHECK_IN_PRESETS[0];
  }
  return CHECK_IN_PRESETS[(index + 1) % CHECK_IN_PRESETS.length];
}

function fmtCheckIn(minutes: number): string {
  return minutes === -1 ? 'off' : `${minutes} min`;
}

/** Configure the captain-visible crew-iterate pause points. */
export class IterateLimitsScreen implements Screen {
  private cursor = 0;

  constructor(private readonly state: IterateLimitsScreenState) {}

  render(): string[] {
    const lines = [
      'Iteration limits',
      '',
      'Crew-iterate pauses for your choice when either limit is reached.',
      'The server keeps a separate derived runaway-loop backstop beyond them.',
      'Check-in is the periodic status wake for implementer and panel watchers.',
      '',
    ];
    for (let index = 0; index < ROWS.length; index++) {
      const pointer = index === this.cursor ? '>' : ' ';
      switch (ROWS[index]) {
        case 'epoch':
          lines.push(`${pointer} rounds per epoch: ${this.state.maxRoundsPerEpoch}   (space cycles)`);
          break;
        case 'total':
          lines.push(`${pointer} total rounds:     ${this.state.maxTotalRounds}   (space cycles)`);
          break;
        case 'checkin':
          lines.push(`${pointer} check-in cadence: ${fmtCheckIn(this.state.checkInMinutes)}   (space cycles)`);
          break;
        case 'back':
          lines.push(`${pointer} back`);
          break;
      }
    }
    lines.push('');
    lines.push('↑/↓ or j/k: move    space: change    enter: save    q/esc: back');
    lines.push('Total rounds must be greater than or equal to rounds per epoch.');
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
      case 'epoch': {
        const next = nextPreset(this.state.maxRoundsPerEpoch);
        this.state.maxRoundsPerEpoch = next;
        this.state.maxTotalRounds = Math.max(this.state.maxTotalRounds, next);
        return 'continue';
      }
      case 'total':
        this.state.maxTotalRounds = nextPreset(
          this.state.maxTotalRounds,
          this.state.maxRoundsPerEpoch,
        );
        return 'continue';
      case 'checkin':
        this.state.checkInMinutes = nextCheckInPreset(this.state.checkInMinutes);
        return 'continue';
      case 'back':
        return 'pop';
    }
  }
}
