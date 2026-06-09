import {
  AGENT_DEFAULT_PATHS,
  type AgentDefaultListPath,
  type AgentDefaultSinglePath,
  type AgentDefaultsState,
} from './agent-defaults-state.js';
import { MultiSelectScreen } from './multi-select-screen.js';
import { SingleSelectScreen } from './single-select-screen.js';
import type { AgentStrengthsEntry } from './agent-strengths-state.js';
import type { KeyResult, Screen, TuiKey } from './screen.js';

export interface AgentInventory {
  readonly agentIds: readonly string[];
  readonly knownIds: ReadonlySet<string>;
  readonly agents?: readonly AgentStrengthsEntry[];
}

interface SingleFieldEntry {
  readonly label: string;
  readonly path: AgentDefaultSinglePath;
  readonly kind: 'single';
}

interface MultiFieldEntry {
  readonly label: string;
  readonly path: AgentDefaultListPath;
  readonly kind: 'multi';
}

type FieldEntry = SingleFieldEntry | MultiFieldEntry;

const FIELD_ENTRIES: readonly FieldEntry[] = [
  {
    label: 'iterate.implementer',
    path: AGENT_DEFAULT_PATHS.iterateImplementer,
    kind: 'single',
  },
  {
    label: 'iterate.reviewers',
    path: AGENT_DEFAULT_PATHS.iterateReviewers,
    kind: 'multi',
  },
  {
    label: 'iterate.banList',
    path: AGENT_DEFAULT_PATHS.iterateBanList,
    kind: 'multi',
  },
  {
    label: 'panel.reviewers',
    path: AGENT_DEFAULT_PATHS.panelReviewers,
    kind: 'multi',
  },
  {
    label: 'panel.banList',
    path: AGENT_DEFAULT_PATHS.panelBanList,
    kind: 'multi',
  },
];

export class AgentDefaultsScreen implements Screen {
  private cursor = 0;

  constructor(
    private readonly state: AgentDefaultsState,
    private readonly inventory: AgentInventory,
  ) {}

  render(): string[] {
    const lines: string[] = [];
    lines.push('Agent defaults');
    lines.push('');
    if (this.inventory.agentIds.length === 0 && !hasConfiguredValues(this.state)) {
      lines.push('  (no agents available — run crew-mcp install first)');
      lines.push('');
      lines.push(`${this.cursor === 0 ? '>' : ' '} back`);
      lines.push('');
      lines.push('enter: back    q / esc: back');
      return lines;
    }
    for (let i = 0; i < FIELD_ENTRIES.length; i++) {
      const entry = FIELD_ENTRIES[i];
      const pointer = i === this.cursor ? '>' : ' ';
      const label = entry.label.padEnd(22);
      lines.push(`${pointer} ${label}  ${this.state.formatValue(entry.path)}`);
    }
    const backIndex = FIELD_ENTRIES.length;
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
    if (this.inventory.agentIds.length === 0 && !hasConfiguredValues(this.state)) {
      return 1;
    }
    return FIELD_ENTRIES.length + 1;
  }

  private activateCurrent(): KeyResult {
    if (this.inventory.agentIds.length === 0 && !hasConfiguredValues(this.state)) {
      return 'pop';
    }
    if (this.cursor === FIELD_ENTRIES.length) return 'pop';
    const field = FIELD_ENTRIES[this.cursor];
    if (field.kind === 'single') {
      return {
        push: new SingleSelectScreen({
          title: `Pick ${field.label}`,
          path: field.path,
          agentIds: this.inventory.agentIds,
          knownIds: this.inventory.knownIds,
          state: this.state,
        }),
      };
    }
    return {
      push: new MultiSelectScreen({
        title: `Pick ${field.label} (order = preference order)`,
        path: field.path,
        agentIds: this.inventory.agentIds,
        knownIds: this.inventory.knownIds,
        state: this.state,
      }),
    };
  }
}

function hasConfiguredValues(state: AgentDefaultsState): boolean {
  return state.getSingle(AGENT_DEFAULT_PATHS.iterateImplementer) !== undefined
    || state.getList(AGENT_DEFAULT_PATHS.iterateReviewers).length > 0
    || state.getList(AGENT_DEFAULT_PATHS.iterateBanList).length > 0
    || state.getList(AGENT_DEFAULT_PATHS.panelReviewers).length > 0
    || state.getList(AGENT_DEFAULT_PATHS.panelBanList).length > 0;
}
