import type { KeyResult, Screen, TuiKey } from './screen.js';

export interface CheckboxToggleEntry<State> {
  readonly kind?: 'toggle';
  readonly label: string;
  readonly description: string;
  readonly get: (state: State) => boolean;
  readonly set: (state: State, value: boolean) => void;
}

export interface CheckboxActionEntry {
  readonly kind: 'action';
  readonly label: string;
  readonly description: string;
  readonly onActivate: () => KeyResult;
}

export type CheckboxListEntry<State> =
  | CheckboxToggleEntry<State>
  | CheckboxActionEntry;

export interface CheckboxListScreenArgs<State> {
  readonly title: string;
  readonly entries: readonly CheckboxListEntry<State>[];
  readonly state: State;
  readonly footer?: string;
  readonly beforeSave?: () => string | undefined;
}

const DEFAULT_FOOTER = '↑/↓ or j/k: move    space: toggle/open    enter: save    q / esc: cancel';

export class CheckboxListScreen<State> implements Screen {
  private cursor = 0;
  private inlineError: string | undefined;

  constructor(private readonly args: CheckboxListScreenArgs<State>) {
    if (args.entries.length === 0) {
      throw new Error('CheckboxListScreen requires at least one entry.');
    }
  }

  render(): string[] {
    const lines: string[] = [];
    lines.push(this.args.title);
    lines.push('');
    for (let i = 0; i < this.args.entries.length; i++) {
      const entry = this.args.entries[i];
      const pointer = i === this.cursor ? '>' : ' ';
      const label = entry.label.padEnd(22);
      if (entry.kind === 'action') {
        lines.push(`${pointer}     ${label}  ${entry.description}`);
        continue;
      }
      const value = entry.get(this.args.state);
      const checkbox = value ? '[x]' : '[ ]';
      lines.push(`${pointer} ${checkbox} ${label}  ${entry.description}`);
    }
    if (this.inlineError) {
      lines.push('');
      lines.push(this.inlineError);
    }
    lines.push('');
    lines.push(this.args.footer ?? DEFAULT_FOOTER);
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
        this.inlineError = undefined;
        return this.activateCurrent();
      case 'return':
      case 'enter':
        this.inlineError = undefined;
        return this.submitCurrent();
      case 'q':
      case 'escape':
        return 'cancel';
      default:
        return 'continue';
    }
  }

  getCursorIndex(): number {
    return this.cursor;
  }

  private move(delta: number): void {
    this.inlineError = undefined;
    this.cursor = (this.cursor + delta + this.args.entries.length) % this.args.entries.length;
  }

  private activateCurrent(): KeyResult {
    const entry = this.args.entries[this.cursor];
    if (entry.kind === 'action') return entry.onActivate();
    entry.set(this.args.state, !entry.get(this.args.state));
    return 'continue';
  }

  private submitCurrent(): KeyResult {
    // Enter always saves the whole config — including when the cursor is
    // on an action row. Opening a submenu is `space`'s job; enter never
    // navigates.
    const error = this.args.beforeSave?.();
    if (error) {
      this.inlineError = error;
      return 'continue';
    }
    return 'save';
  }
}
