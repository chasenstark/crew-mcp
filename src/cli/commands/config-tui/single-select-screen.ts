import type { AgentDefaultSinglePath, AgentDefaultsState } from './agent-defaults-state.js';
import type { KeyResult, Screen, TuiKey } from './screen.js';

export interface SingleSelectScreenArgs {
  readonly title: string;
  readonly path: AgentDefaultSinglePath;
  readonly agentIds: readonly string[];
  readonly knownIds: ReadonlySet<string>;
  readonly state: AgentDefaultsState;
}

type SingleSelectOption =
  | { readonly kind: 'agent'; readonly id: string }
  | { readonly kind: 'unset' }
  | { readonly kind: 'back' };

export class SingleSelectScreen implements Screen {
  private cursor = 0;
  private readonly options: readonly SingleSelectOption[];

  constructor(private readonly args: SingleSelectScreenArgs) {
    const current = args.state.getSingle(args.path);
    const ids = unique([
      ...args.agentIds,
      ...(current && !args.agentIds.includes(current) ? [current] : []),
    ]);
    this.options = [
      ...ids.map((id) => ({ kind: 'agent' as const, id })),
      { kind: 'unset' },
      { kind: 'back' },
    ];
  }

  render(): string[] {
    const lines: string[] = [];
    const current = this.args.state.getSingle(this.args.path);
    lines.push(this.args.title);
    lines.push('');
    if (this.args.agentIds.length === 0 && this.options.every((option) => option.kind !== 'agent')) {
      lines.push('  (no agents available — run crew-mcp install first)');
      lines.push('');
    }
    for (let i = 0; i < this.options.length; i++) {
      const option = this.options[i];
      const pointer = i === this.cursor ? '>' : ' ';
      if (option.kind === 'agent') {
        const radio = current === option.id ? '(•)' : '( )';
        const suffix = this.args.knownIds.has(option.id)
          ? ''
          : '  (unknown — not in list_agents)';
        lines.push(`${pointer} ${radio} ${option.id}${suffix}`);
        continue;
      }
      if (option.kind === 'unset') {
        const radio = current === undefined ? '(•)' : '( )';
        lines.push(`${pointer} ${radio} (unset — fall back to heuristic)`);
        continue;
      }
      lines.push(`${pointer} back`);
    }
    lines.push('');
    lines.push('↑/↓ or j/k: move    space / enter: select    q / esc: back');
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
        return this.selectCurrent();
      case 'q':
      case 'escape':
        return 'pop';
      default:
        return 'continue';
    }
  }

  private move(delta: number): void {
    this.cursor = (this.cursor + delta + this.options.length) % this.options.length;
  }

  private selectCurrent(): KeyResult {
    const option = this.options[this.cursor];
    if (option.kind === 'back') return 'pop';
    if (option.kind === 'unset') {
      this.args.state.setSingle(this.args.path, undefined);
      return 'pop';
    }
    this.args.state.setSingle(this.args.path, option.id);
    return 'pop';
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
