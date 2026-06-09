import type { AgentStrengthsState } from './agent-strengths-state.js';
import type { KeyResult, Screen, TuiKey } from './screen.js';
import { StrengthsMultiSelectScreen } from './strengths-multi-select-screen.js';
import { UseWhenInputScreen } from './use-when-input-screen.js';

export class AgentStrengthsListScreen implements Screen {
  private cursor = 0;

  constructor(private readonly state: AgentStrengthsState) {}

  render(): string[] {
    const lines: string[] = [];
    const agents = this.state.agentNames();
    lines.push('Agent strengths');
    lines.push('');
    if (agents.length === 0) {
      lines.push('  (no agents available — run crew-mcp install first)');
      lines.push('');
      lines.push(`${this.cursor === 0 ? '>' : ' '} back`);
      lines.push('');
      lines.push('enter: back    q / esc: back');
      return lines;
    }
    for (let i = 0; i < agents.length; i++) {
      const agentName = agents[i];
      const pointer = i === this.cursor ? '>' : ' ';
      lines.push(`${pointer} ${agentName.padEnd(16)}  ${this.state.formatStrengths(agentName)}`);
    }
    const backIndex = agents.length;
    lines.push(`${backIndex === this.cursor ? '>' : ' '} back`);
    lines.push('');
    lines.push('↑/↓ or j/k: move    space / enter: open    q / esc: back');
    return lines;
  }

  onKey(key: TuiKey): KeyResult {
    if (key.ctrl && key.name === 'c') return 'cancel';
    const entryCount = this.entryCount();
    switch (key.name) {
      case 'up':
      case 'k':
        this.cursor = (this.cursor - 1 + entryCount) % entryCount;
        return 'continue';
      case 'down':
      case 'j':
        this.cursor = (this.cursor + 1) % entryCount;
        return 'continue';
      case 'space':
      case 'return':
      case 'enter':
        return this.activateCurrent();
      case 'q':
      case 'escape':
        return 'pop';
      default:
        return 'continue';
    }
  }

  getCursorIndex(): number {
    return this.cursor;
  }

  private entryCount(): number {
    return Math.max(1, this.state.agentNames().length + 1);
  }

  private activateCurrent(): KeyResult {
    const agents = this.state.agentNames();
    if (agents.length === 0 || this.cursor === agents.length) return 'pop';
    return { push: new AgentStrengthEditScreen(this.state, agents[this.cursor]) };
  }
}

export class AgentStrengthEditScreen implements Screen {
  private cursor = 0;

  constructor(
    private readonly state: AgentStrengthsState,
    private readonly agentName: string,
  ) {}

  render(): string[] {
    const entries = this.entries();
    const lines: string[] = [];
    lines.push(`Edit ${this.agentName}`);
    lines.push('');
    for (let i = 0; i < entries.length; i++) {
      const pointer = i === this.cursor ? '>' : ' ';
      lines.push(`${pointer} ${entries[i].label.padEnd(12)}  ${entries[i].value}`);
    }
    lines.push('');
    lines.push('↑/↓ or j/k: move    space / enter: open    q / esc: back');
    return lines;
  }

  onKey(key: TuiKey): KeyResult {
    if (key.ctrl && key.name === 'c') return 'cancel';
    const count = this.entries().length;
    switch (key.name) {
      case 'up':
      case 'k':
        this.cursor = (this.cursor - 1 + count) % count;
        return 'continue';
      case 'down':
      case 'j':
        this.cursor = (this.cursor + 1) % count;
        return 'continue';
      case 'space':
      case 'return':
      case 'enter':
        return this.activateCurrent();
      case 'q':
      case 'escape':
        return 'pop';
      default:
        return 'continue';
    }
  }

  private activateCurrent(): KeyResult {
    if (this.cursor === 0) {
      return {
        push: new StrengthsMultiSelectScreen({
          agentName: this.agentName,
          state: this.state,
        }),
      };
    }
    if (this.cursor === 1) {
      return {
        push: new UseWhenInputScreen({
          agentName: this.agentName,
          state: this.state,
        }),
      };
    }
    return 'pop';
  }

  private entries(): Array<{ label: string; value: string }> {
    return [
      { label: 'strengths', value: this.state.formatStrengths(this.agentName) },
      { label: 'useWhen', value: this.state.formatUseWhen(this.agentName) },
      { label: 'back', value: '' },
    ];
  }
}
