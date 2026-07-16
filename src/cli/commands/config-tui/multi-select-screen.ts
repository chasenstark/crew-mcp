import type { AgentDefaultListPath, AgentDefaultsState } from './agent-defaults-state.js';
import type { KeyResult, Screen, TuiKey } from './screen.js';

export interface MultiSelectScreenArgs {
  readonly title: string;
  readonly path: AgentDefaultListPath;
  readonly agentIds: readonly string[];
  readonly knownIds: ReadonlySet<string>;
  readonly state: AgentDefaultsState;
}

export class MultiSelectScreen implements Screen {
  private cursor = 0;
  private selected: string[];
  private readonly initial: readonly string[];
  private readonly options: readonly string[];

  constructor(private readonly args: MultiSelectScreenArgs) {
    this.selected = [...args.state.getList(args.path)];
    this.initial = [...this.selected];
    this.options = unique([
      ...args.agentIds,
      ...this.selected.filter((id) => !args.agentIds.includes(id)),
    ]);
  }

  render(): string[] {
    const lines: string[] = [];
    const unknownCount = this.selected.filter((id) => !this.args.knownIds.has(id)).length;
    lines.push(this.args.title);
    if (unknownCount > 0) {
      lines.push(`Note: ${unknownCount} configured id(s) are not in list_agents`);
    }
    lines.push('');
    if (this.options.length === 0) {
      lines.push('  (no agents available — run crew-mcp install first)');
      lines.push('');
    }
    for (let i = 0; i < this.options.length; i++) {
      const id = this.options[i];
      const pointer = i === this.cursor ? '>' : ' ';
      const selectedIndex = this.selected.indexOf(id);
      const checkbox = selectedIndex >= 0 ? '[x]' : '[ ]';
      const display = selectedIndex >= 0
        ? `${selectedIndex + 1}. ${id}`
        : `   ${id}`;
      const suffix = this.args.knownIds.has(id)
        ? ''
        : '  (unknown — not in list_agents)';
      lines.push(`${pointer} ${checkbox} ${display}${suffix}`);
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
        // On the `back` row, space leaves; on an item it toggles in the
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
   * Commit-on-leave means edits survive `esc`/`back` so the user can
   * edit several fields before pressing enter to save everything. Skip
   * the write when nothing changed so merely opening and backing out of
   * a picker doesn't mark the config dirty.
   */
  private commitAndLeave(result: 'pop' | 'save'): KeyResult {
    if (!sameOrder(this.initial, this.selected)) {
      this.args.state.setList(this.args.path, this.selected);
    }
    return result;
  }

  private move(delta: number): void {
    this.cursor = (this.cursor + delta + this.options.length + 1) % (this.options.length + 1);
  }

  private toggle(id: string): void {
    if (this.selected.includes(id)) {
      this.selected = this.selected.filter((selectedId) => selectedId !== id);
      return;
    }
    this.selected = [...this.selected, id];
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
