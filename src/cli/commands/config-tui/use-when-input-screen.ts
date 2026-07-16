import type { AgentStrengthsState } from './agent-strengths-state.js';
import type { KeyResult, Screen, TuiKey } from './screen.js';

const INPUT_WINDOW = 58;

export interface UseWhenInputScreenArgs {
  readonly agentName: string;
  readonly state: AgentStrengthsState;
  readonly windowSize?: number;
}

export class UseWhenInputScreen implements Screen {
  private value: string;
  private cursor: number;
  private windowStart = 0;
  private readonly windowSize: number;

  constructor(private readonly args: UseWhenInputScreenArgs) {
    this.value = args.state.getUseWhen(args.agentName) ?? '';
    this.cursor = this.value.length;
    this.windowSize = Math.max(1, args.windowSize ?? INPUT_WINDOW);
  }

  render(): string[] {
    this.keepCursorVisible();
    const visible = this.value.slice(this.windowStart, this.windowStart + this.windowSize);
    const cursorInWindow = this.cursor - this.windowStart;
    const withCursor = `${visible.slice(0, cursorInWindow)}|${visible.slice(cursorInWindow)}`;
    const prefix = this.windowStart > 0 ? '<' : ' ';
    const suffix = this.windowStart + this.windowSize < this.value.length ? '>' : ' ';
    return [
      `Use when for ${this.args.agentName}`,
      '',
      `  ${prefix}${withCursor}${suffix}`,
      '',
      'enter: save    esc: cancel    arrows: move    backspace/delete: edit',
    ];
  }

  onKey(key: TuiKey): KeyResult {
    if (key.ctrl && key.name === 'c') return 'cancel';

    switch (key.name) {
      case 'return':
      case 'enter':
        // Enter commits this field and saves the whole config (esc still
        // cancels the edit without committing).
        this.args.state.setUseWhen(this.args.agentName, this.value);
        return 'save';
      case 'escape':
        return 'pop';
      case 'left':
        this.cursor = Math.max(0, this.cursor - 1);
        return 'continue';
      case 'right':
        this.cursor = Math.min(this.value.length, this.cursor + 1);
        return 'continue';
      case 'home':
        this.cursor = 0;
        return 'continue';
      case 'end':
        this.cursor = this.value.length;
        return 'continue';
      case 'backspace':
        if (this.cursor > 0) {
          this.value = `${this.value.slice(0, this.cursor - 1)}${this.value.slice(this.cursor)}`;
          this.cursor -= 1;
        }
        return 'continue';
      case 'delete':
        if (this.cursor < this.value.length) {
          this.value = `${this.value.slice(0, this.cursor)}${this.value.slice(this.cursor + 1)}`;
        }
        return 'continue';
      default:
        break;
    }

    const char = printableChar(key);
    if (char === undefined) return 'continue';
    this.value = `${this.value.slice(0, this.cursor)}${char}${this.value.slice(this.cursor)}`;
    this.cursor += char.length;
    return 'continue';
  }

  private keepCursorVisible(): void {
    if (this.cursor < this.windowStart) {
      this.windowStart = this.cursor;
      return;
    }
    const rightEdge = this.windowStart + this.windowSize;
    if (this.cursor > rightEdge) {
      this.windowStart = this.cursor - this.windowSize;
    }
  }
}

function printableChar(key: TuiKey): string | undefined {
  if (key.ctrl) return undefined;
  if (key.name === 'space') return ' ';
  if (key.sequence && key.sequence.length === 1 && !isControlCharacter(key.sequence)) {
    return key.sequence;
  }
  if (key.name && key.name.length === 1 && !isControlCharacter(key.name)) {
    return key.name;
  }
  return undefined;
}

function isControlCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return code < 32 || code === 127;
}
