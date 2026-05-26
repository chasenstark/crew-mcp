import type { WorkflowAgentDefaultsConfig } from '../../../workflow/types.js';
import {
  setConfigValue as defaultSetConfigValue,
  unsetConfigValue as defaultUnsetConfigValue,
} from '../../../workflow/config-service.js';

export const AGENT_DEFAULT_PATHS = {
  iterateImplementer: 'workflow.agentDefaults.iterate.implementer',
  iterateReviewers: 'workflow.agentDefaults.iterate.reviewers',
  iterateBanList: 'workflow.agentDefaults.iterate.banList',
  panelReviewers: 'workflow.agentDefaults.panel.reviewers',
  panelBanList: 'workflow.agentDefaults.panel.banList',
} as const;

export type AgentDefaultSinglePath = typeof AGENT_DEFAULT_PATHS.iterateImplementer;

export type AgentDefaultListPath =
  | typeof AGENT_DEFAULT_PATHS.iterateReviewers
  | typeof AGENT_DEFAULT_PATHS.iterateBanList
  | typeof AGENT_DEFAULT_PATHS.panelReviewers
  | typeof AGENT_DEFAULT_PATHS.panelBanList;

export type AgentDefaultPath = AgentDefaultSinglePath | AgentDefaultListPath;

export interface AgentDefaultsSnapshot {
  readonly iterate: {
    readonly implementer?: string;
    readonly reviewers: readonly string[];
    readonly banList: readonly string[];
  };
  readonly panel: {
    readonly reviewers: readonly string[];
    readonly banList: readonly string[];
  };
}

export type SetConfigValueFn = (cwd: string, path: string, rawValue: unknown) => unknown;
export type UnsetConfigValueFn = (cwd: string, path: string) => unknown;

export interface AgentDefaultsPersistence {
  readonly setConfigValue?: SetConfigValueFn;
  readonly unsetConfigValue?: UnsetConfigValueFn;
}

export class AgentDefaultsState {
  private iterateImplementer: string | undefined;
  private iterateReviewers: string[];
  private iterateBanList: string[];
  private panelReviewers: string[];
  private panelBanList: string[];
  private readonly initial: AgentDefaultsSnapshot;
  private readonly touchedPaths = new Set<AgentDefaultPath>();

  constructor(defaults: WorkflowAgentDefaultsConfig | undefined) {
    this.iterateImplementer = normalizeOptionalId(defaults?.iterate?.implementer);
    this.iterateReviewers = normalizeIdList(defaults?.iterate?.reviewers);
    this.iterateBanList = normalizeIdList(defaults?.iterate?.banList);
    this.panelReviewers = normalizeIdList(defaults?.panel?.reviewers);
    this.panelBanList = normalizeIdList(defaults?.panel?.banList);
    this.initial = this.snapshot();
  }

  snapshot(): AgentDefaultsSnapshot {
    return {
      iterate: {
        ...(this.iterateImplementer !== undefined
          ? { implementer: this.iterateImplementer }
          : {}),
        reviewers: [...this.iterateReviewers],
        banList: [...this.iterateBanList],
      },
      panel: {
        reviewers: [...this.panelReviewers],
        banList: [...this.panelBanList],
      },
    };
  }

  hasChanges(): boolean {
    return this.touchedPaths.size > 0 || !sameSnapshot(this.initial, this.snapshot());
  }

  getSingle(path: AgentDefaultSinglePath): string | undefined {
    switch (path) {
      case AGENT_DEFAULT_PATHS.iterateImplementer:
        return this.iterateImplementer;
    }
  }

  setSingle(path: AgentDefaultSinglePath, value: string | undefined): void {
    this.touchedPaths.add(path);
    switch (path) {
      case AGENT_DEFAULT_PATHS.iterateImplementer:
        this.iterateImplementer = normalizeOptionalId(value);
        return;
    }
  }

  getList(path: AgentDefaultListPath): readonly string[] {
    switch (path) {
      case AGENT_DEFAULT_PATHS.iterateReviewers:
        return [...this.iterateReviewers];
      case AGENT_DEFAULT_PATHS.iterateBanList:
        return [...this.iterateBanList];
      case AGENT_DEFAULT_PATHS.panelReviewers:
        return [...this.panelReviewers];
      case AGENT_DEFAULT_PATHS.panelBanList:
        return [...this.panelBanList];
    }
  }

  setList(path: AgentDefaultListPath, values: readonly string[]): void {
    this.touchedPaths.add(path);
    const normalized = normalizeIdList(values);
    switch (path) {
      case AGENT_DEFAULT_PATHS.iterateReviewers:
        this.iterateReviewers = normalized;
        return;
      case AGENT_DEFAULT_PATHS.iterateBanList:
        this.iterateBanList = normalized;
        return;
      case AGENT_DEFAULT_PATHS.panelReviewers:
        this.panelReviewers = normalized;
        return;
      case AGENT_DEFAULT_PATHS.panelBanList:
        this.panelBanList = normalized;
        return;
    }
  }

  formatValue(path: AgentDefaultPath): string {
    if (path === AGENT_DEFAULT_PATHS.iterateImplementer) {
      return this.iterateImplementer ?? '(unset)';
    }
    const values = this.getList(path);
    return values.length > 0 ? values.join(', ') : '(empty)';
  }

  validateForSave(): string | undefined {
    return collisionError('iterate', this.iterateReviewers, this.iterateBanList)
      ?? collisionError('panel', this.panelReviewers, this.panelBanList);
  }
}

export function applyAgentDefaultsState(
  cwd: string,
  state: AgentDefaultsState,
  persistence: AgentDefaultsPersistence = {},
): void {
  const setConfigValue = persistence.setConfigValue ?? defaultSetConfigValue;
  const unsetConfigValue = persistence.unsetConfigValue ?? defaultUnsetConfigValue;
  const implementer = state.getSingle(AGENT_DEFAULT_PATHS.iterateImplementer);
  if (implementer === undefined) {
    unsetConfigValue(cwd, AGENT_DEFAULT_PATHS.iterateImplementer);
  } else {
    setConfigValue(cwd, AGENT_DEFAULT_PATHS.iterateImplementer, implementer);
  }

  applyListPair(cwd, state, unsetConfigValue, setConfigValue, [
    AGENT_DEFAULT_PATHS.iterateReviewers,
    AGENT_DEFAULT_PATHS.iterateBanList,
  ]);
  applyListPair(cwd, state, unsetConfigValue, setConfigValue, [
    AGENT_DEFAULT_PATHS.panelReviewers,
    AGENT_DEFAULT_PATHS.panelBanList,
  ]);
}

function applyListPair(
  cwd: string,
  state: AgentDefaultsState,
  unsetConfigValue: UnsetConfigValueFn,
  setConfigValue: SetConfigValueFn,
  paths: readonly [AgentDefaultListPath, AgentDefaultListPath],
): void {
  for (const path of paths) {
    unsetConfigValue(cwd, path);
  }
  for (const path of paths) {
    const values = state.getList(path);
    if (values.length > 0) {
      setConfigValue(cwd, path, JSON.stringify(values));
    }
  }
}

function normalizeOptionalId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeIdList(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values ?? []) {
    const normalized = value.trim();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function collisionError(
  scope: 'iterate' | 'panel',
  reviewers: readonly string[],
  banList: readonly string[],
): string | undefined {
  const banned = new Set(banList);
  const collision = reviewers.find((id) => banned.has(id));
  if (!collision) return undefined;
  return `Conflict: '${collision}' is in both ${scope}.reviewers and ${scope}.banList. Remove one before saving.`;
}

function sameSnapshot(a: AgentDefaultsSnapshot, b: AgentDefaultsSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
