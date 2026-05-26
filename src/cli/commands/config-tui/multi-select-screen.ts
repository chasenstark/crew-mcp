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
  private readonly options: readonly string[];

  constructor(private readonly args: MultiSelectScreenArgs) {
    this.selected = [...args.state.getList(args.path)];
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
    lines.push('space: toggle    j/k or arrows: move    enter: confirm    q / esc: cancel');
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
        if (this.cursor === this.options.length) return 'pop';
        this.toggle(this.options[this.cursor]);
        return 'continue';
      case 'return':
      case 'enter':
        if (this.cursor === this.options.length) return 'pop';
        this.args.state.setList(this.args.path, this.selected);
        return 'pop';
      case 'q':
      case 'escape':
        return 'pop';
      default:
        return 'continue';
    }
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
