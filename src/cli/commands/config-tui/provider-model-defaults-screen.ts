import type { ModelDescriptor } from '../../../adapters/types.js';
import type { ProviderModelDefaultsState } from './provider-model-defaults-state.js';
import type { KeyResult, Screen, TuiKey } from './screen.js';

const INPUT_WINDOW = 58;

export class ProviderModelDefaultsScreen implements Screen {
  private cursor = 0;

  constructor(private readonly state: ProviderModelDefaultsState) {}

  render(): string[] {
    const lines: string[] = ['Provider model defaults', ''];
    const providers = this.state.providerNames();
    if (providers.length === 0) {
      lines.push('  (no model-selecting providers available)');
      lines.push('');
      lines.push(`${this.cursor === 0 ? '>' : ' '} back`);
      lines.push('');
      lines.push('space: back    enter: save    q / esc: back');
      return lines;
    }

    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i];
      const pointer = i === this.cursor ? '>' : ' ';
      const label = `${this.state.displayName(provider)} (${provider})`.padEnd(30);
      lines.push(`${pointer} ${label}  ${this.state.formatModel(provider)}`);
    }
    const backIndex = providers.length;
    lines.push(`${backIndex === this.cursor ? '>' : ' '} back`);
    lines.push('');
    lines.push('↑/↓ or j/k: move    space: open    enter: save    q / esc: back');
    return lines;
  }

  onKey(key: TuiKey): KeyResult {
    if (key.ctrl && key.name === 'c') return 'cancel';
    const count = Math.max(1, this.state.providerNames().length + 1);
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
        return this.activateCurrent();
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

  private activateCurrent(): KeyResult {
    const providers = this.state.providerNames();
    if (providers.length === 0 || this.cursor === providers.length) return 'pop';
    return {
      push: new ProviderModelSelectScreen({
        providerName: providers[this.cursor],
        state: this.state,
      }),
    };
  }
}

type ModelOption =
  | { readonly kind: 'cli-default' }
  | { readonly kind: 'model'; readonly descriptor: ModelDescriptor; readonly stale?: boolean }
  | { readonly kind: 'custom' }
  | { readonly kind: 'back' };

export class ProviderModelSelectScreen implements Screen {
  private cursor = 0;
  private readonly options: readonly ModelOption[];

  constructor(private readonly args: {
    readonly providerName: string;
    readonly state: ProviderModelDefaultsState;
  }) {
    const models = [...args.state.models(args.providerName)];
    const current = args.state.getModel(args.providerName);
    const currentIsListed = current === undefined
      || models.some((model) => model.model === current);
    this.options = [
      { kind: 'cli-default' },
      ...models.map((descriptor) => ({ kind: 'model' as const, descriptor })),
      ...(!currentIsListed && current !== undefined
        ? [{
            kind: 'model' as const,
            descriptor: { model: current, displayName: current },
            stale: true,
          }]
        : []),
      { kind: 'custom' },
      { kind: 'back' },
    ];
  }

  render(): string[] {
    const current = this.args.state.getModel(this.args.providerName);
    const lines: string[] = [
      `Default model for ${this.args.state.displayName(this.args.providerName)}`,
      '',
    ];
    for (let i = 0; i < this.options.length; i++) {
      const option = this.options[i];
      const pointer = i === this.cursor ? '>' : ' ';
      if (option.kind === 'cli-default') {
        const radio = current === undefined ? '(•)' : '( )';
        lines.push(`${pointer} ${radio} (provider CLI default)`);
        continue;
      }
      if (option.kind === 'model') {
        const radio = current === option.descriptor.model ? '(•)' : '( )';
        const detail = formatDescriptor(option.descriptor);
        const suffix = option.stale
          ? '  (configured; not in current catalog)'
          : option.descriptor.isDefault
            ? '  (provider catalog default)'
            : '';
        lines.push(`${pointer} ${radio} ${detail}${suffix}`);
        continue;
      }
      if (option.kind === 'custom') {
        lines.push(`${pointer}     Enter exact model id...`);
        continue;
      }
      lines.push(`${pointer}     back`);
    }
    const warnings = this.args.state.warnings(this.args.providerName);
    if (warnings.length > 0) {
      lines.push('');
      for (const warning of warnings.slice(0, 2)) lines.push(`warning: ${warning}`);
    }
    lines.push('');
    lines.push('↑/↓ or j/k: move    space: select/open    enter: save    q / esc: back');
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
        return this.selectCurrent();
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
    this.cursor = (this.cursor + delta + this.options.length) % this.options.length;
  }

  private selectCurrent(): KeyResult {
    const option = this.options[this.cursor];
    if (option.kind === 'back') return 'pop';
    if (option.kind === 'custom') {
      return {
        push: new ProviderModelInputScreen({
          providerName: this.args.providerName,
          state: this.args.state,
        }),
      };
    }
    this.args.state.setModel(
      this.args.providerName,
      option.kind === 'cli-default' ? undefined : option.descriptor.model,
    );
    return 'pop';
  }
}

export class ProviderModelInputScreen implements Screen {
  private value: string;
  private cursor: number;
  private windowStart = 0;
  private readonly windowSize: number;

  constructor(private readonly args: {
    readonly providerName: string;
    readonly state: ProviderModelDefaultsState;
    readonly windowSize?: number;
  }) {
    this.value = args.state.getModel(args.providerName) ?? '';
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
      `Exact model id for ${this.args.state.displayName(this.args.providerName)}`,
      '',
      `  ${prefix}${withCursor}${suffix}`,
      '',
      'The provider validates this value before Crew saves it.',
      'enter: save    esc: cancel    arrows: move    backspace/delete: edit',
    ];
  }

  onKey(key: TuiKey): KeyResult {
    if (key.ctrl && key.name === 'c') return 'cancel';
    switch (key.name) {
      case 'return':
      case 'enter':
        this.args.state.setModel(this.args.providerName, this.value);
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

function formatDescriptor(descriptor: ModelDescriptor): string {
  return descriptor.displayName === descriptor.model
    ? descriptor.model
    : `${descriptor.displayName} [${descriptor.model}]`;
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
