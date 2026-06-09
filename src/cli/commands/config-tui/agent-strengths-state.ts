import { readRawAgentPrefsFile, writeRawAgentPrefsFile } from '../agents/store.js';

export interface AgentStrengthsEntry {
  readonly name: string;
  readonly strengths: readonly string[];
  readonly useWhen?: string;
}

export interface AgentStrengthsPatch {
  readonly strengths?: readonly string[] | undefined;
  readonly useWhen?: string | undefined;
}

export interface AgentStrengthsPersistence {
  readonly setAgentStrengths?: (
    crewHome: string,
    agentName: string,
    patch: AgentStrengthsPatch,
  ) => void;
}

interface MutableAgentStrengthsEntry {
  readonly name: string;
  strengths: string[] | undefined;
  useWhen: string | undefined;
}

export class AgentStrengthsState {
  private readonly agents = new Map<string, MutableAgentStrengthsEntry>();
  private readonly touchedStrengths = new Set<string>();
  private readonly touchedUseWhen = new Set<string>();

  constructor(entries: readonly AgentStrengthsEntry[]) {
    for (const entry of entries) {
      if (!entry.name.trim()) continue;
      this.agents.set(entry.name, {
        name: entry.name,
        strengths: normalizeStrengthTags(entry.strengths),
        useWhen: normalizeUseWhen(entry.useWhen),
      });
    }
  }

  agentNames(): string[] {
    return [...this.agents.keys()];
  }

  hasAgents(): boolean {
    return this.agents.size > 0;
  }

  hasChanges(): boolean {
    return this.touchedStrengths.size > 0 || this.touchedUseWhen.size > 0;
  }

  getStrengths(agentName: string): readonly string[] {
    return [...(this.entry(agentName).strengths ?? [])];
  }

  setStrengths(agentName: string, values: readonly string[] | undefined): void {
    this.entry(agentName).strengths = values === undefined
      ? undefined
      : normalizeStrengthTags(values);
    this.touchedStrengths.add(agentName);
  }

  getUseWhen(agentName: string): string | undefined {
    return this.entry(agentName).useWhen;
  }

  setUseWhen(agentName: string, value: string | undefined): void {
    this.entry(agentName).useWhen = normalizeUseWhen(value);
    this.touchedUseWhen.add(agentName);
  }

  formatStrengths(agentName: string): string {
    const strengths = this.getStrengths(agentName);
    return strengths.length > 0 ? strengths.join(', ') : '(empty)';
  }

  formatUseWhen(agentName: string): string {
    return this.getUseWhen(agentName) ?? '(unset)';
  }

  patches(): Array<{ agentName: string; patch: AgentStrengthsPatch }> {
    const names = uniqueStrings([
      ...this.touchedStrengths,
      ...this.touchedUseWhen,
    ]);
    return names.map((agentName) => {
      const entry = this.entry(agentName);
      const patch: { strengths?: readonly string[] | undefined; useWhen?: string | undefined } = {};
      if (this.touchedStrengths.has(agentName)) {
        patch.strengths = entry.strengths === undefined ? undefined : [...entry.strengths];
      }
      if (this.touchedUseWhen.has(agentName)) {
        patch.useWhen = entry.useWhen ?? '';
      }
      return { agentName, patch };
    });
  }

  private entry(agentName: string): MutableAgentStrengthsEntry {
    const entry = this.agents.get(agentName);
    if (!entry) {
      throw new Error(`Unknown agent "${agentName}".`);
    }
    return entry;
  }
}

export function applyAgentStrengthsState(
  crewHome: string,
  state: AgentStrengthsState,
  persistence: AgentStrengthsPersistence = {},
): void {
  const set = persistence.setAgentStrengths ?? setAgentStrengths;
  for (const { agentName, patch } of state.patches()) {
    set(crewHome, agentName, patch);
  }
}

export function setAgentStrengths(
  crewHome: string,
  agentName: string,
  patch: AgentStrengthsPatch,
): void {
  const raw = readRawAgentPrefsFile(crewHome);
  const current = isRecord(raw[agentName]) ? raw[agentName] : {};
  const next: Record<string, unknown> = { ...current };

  if (Object.prototype.hasOwnProperty.call(patch, 'strengths')) {
    if (patch.strengths === undefined) {
      delete next.strengths;
    } else {
      next.strengths = normalizeStrengthTags(patch.strengths);
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'useWhen')) {
    const useWhen = normalizeUseWhen(patch.useWhen);
    if (useWhen === undefined) {
      delete next.useWhen;
    } else {
      next.useWhen = useWhen;
    }
  }

  writeRawAgentPrefsFile(crewHome, {
    ...raw,
    [agentName]: next,
  });
}

function normalizeStrengthTags(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeUseWhen(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
