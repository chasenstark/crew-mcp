export interface TuiKey {
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly sequence?: string;
}

export type KeyResult =
  | 'continue'
  | 'pop'
  | 'save'
  | 'cancel'
  | { readonly push: Screen };

export interface Screen {
  render(): string[];
  onKey(key: TuiKey): KeyResult;
}

export function isPushResult(result: KeyResult): result is { readonly push: Screen } {
  return typeof result === 'object' && result !== null && 'push' in result;
}
