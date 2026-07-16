import { CURATED_STRENGTH_TAGS } from '../../../adapters/strengths.js';
import type { AgentStrengthsState } from './agent-strengths-state.js';
import type { KeyResult, Screen, TuiKey } from './screen.js';

export interface StrengthsMultiSelectScreenArgs {
  readonly agentName: string;
  readonly state: AgentStrengthsState;
}

export class StrengthsMultiSelectScreen implements Screen {
  private cursor = 0;
  private selected: string[];
  private readonly initial: readonly string[];
  private readonly options: readonly string[];

  constructor(private readonly args: StrengthsMultiSelectScreenArgs) {
    this.selected = [...args.state.getStrengths(args.agentName)];
    this.initial = [...this.selected];
    this.options = unique([
      ...CURATED_STRENGTH_TAGS,
      ...this.selected.filter((tag) => !CURATED_STRENGTH_TAGS.includes(tag)),
    ]);
  }

  render(): string[] {
    const lines: string[] = [];
    lines.push(`Strengths for ${this.args.agentName}`);
    lines.push('');
    for (let i = 0; i < this.options.length; i++) {
      const tag = this.options[i];
      const pointer = i === this.cursor ? '>' : ' ';
      const checkbox = this.selected.includes(tag) ? '[x]' : '[ ]';
      const custom = CURATED_STRENGTH_TAGS.includes(tag) ? '' : '  (custom)';
      lines.push(`${pointer} ${checkbox} ${tag}${custom}`);
    }
    const backCursor = this.options.length;
    lines.push(`${backCursor === this.cursor ? '>' : ' '} back`);
    lines.push('');
    lines.push('space: toggle    j/k or arrows: move    enter: save    q / esc: back');
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
        // On the `back` row, space leaves; on a tag it toggles in the
        // local buffer (committed on leave).
        if (this.cursor === this.options.length) return this.commitAndLeave('pop');
        this.toggle(this.options[this.cursor]);
        return 'continue';
      case 'return':
      case 'enter':
        return this.commitAndLeave('save');
      case 'q':
      case 'escape':
        return this.commitAndLeave('pop');
      default:
        return 'continue';
    }
  }

  /**
   * Flush the local selection buffer into shared state, then leave.
   * Commit-on-leave keeps edits when the user backs out with `esc`; the
   * unchanged guard avoids marking the config dirty on a no-op visit.
   */
  private commitAndLeave(result: 'pop' | 'save'): KeyResult {
    if (!sameOrder(this.initial, this.selected)) {
      this.args.state.setStrengths(this.args.agentName, this.selected);
    }
    return result;
  }

  private move(delta: number): void {
    this.cursor = (this.cursor + delta + this.options.length + 1) % (this.options.length + 1);
  }

  private toggle(tag: string): void {
    if (this.selected.includes(tag)) {
      this.selected = this.selected.filter((selected) => selected !== tag);
      return;
    }
    this.selected = [...this.selected, tag];
  }
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
