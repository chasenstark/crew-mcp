import type { ModelDescriptor } from '../../../adapters/types.js';
import {
  readRawAgentPrefsFile,
  writeRawAgentPrefsFile,
  type RawAgentPrefs,
} from '../agents/store.js';

export interface ProviderModelInventoryEntry {
  readonly name: string;
  readonly displayName: string;
  readonly configuredModel?: string;
  readonly models: readonly ModelDescriptor[];
  readonly warnings?: readonly string[];
}

export interface ProviderModelDefaultChange {
  readonly providerName: string;
  readonly model?: string;
}

interface MutableProviderModelEntry {
  readonly name: string;
  readonly displayName: string;
  readonly models: readonly ModelDescriptor[];
  readonly warnings: readonly string[];
  model: string | undefined;
}

export class ProviderModelDefaultsState {
  private readonly providers = new Map<string, MutableProviderModelEntry>();
  private readonly initialModels = new Map<string, string | undefined>();

  constructor(entries: readonly ProviderModelInventoryEntry[]) {
    for (const entry of entries) {
      const name = entry.name.trim();
      if (name.length === 0 || this.providers.has(name)) continue;
      const model = normalizeModel(entry.configuredModel);
      this.providers.set(name, {
        name,
        displayName: entry.displayName.trim() || name,
        models: normalizeModels(entry.models),
        warnings: [...(entry.warnings ?? [])],
        model,
      });
      this.initialModels.set(name, model);
    }
  }

  providerNames(): string[] {
    return [...this.providers.keys()];
  }

  hasProviders(): boolean {
    return this.providers.size > 0;
  }

  displayName(providerName: string): string {
    return this.entry(providerName).displayName;
  }

  getModel(providerName: string): string | undefined {
    return this.entry(providerName).model;
  }

  setModel(providerName: string, model: string | undefined): void {
    this.entry(providerName).model = normalizeModel(model);
  }

  models(providerName: string): readonly ModelDescriptor[] {
    return this.entry(providerName).models;
  }

  warnings(providerName: string): readonly string[] {
    return this.entry(providerName).warnings;
  }

  formatModel(providerName: string): string {
    return this.getModel(providerName) ?? '(provider CLI default)';
  }

  hasChanges(): boolean {
    return this.changes().length > 0;
  }

  changes(): ProviderModelDefaultChange[] {
    const out: ProviderModelDefaultChange[] = [];
    for (const [providerName, entry] of this.providers) {
      if (entry.model === this.initialModels.get(providerName)) continue;
      out.push({
        providerName,
        ...(entry.model !== undefined ? { model: entry.model } : {}),
      });
    }
    return out;
  }

  private entry(providerName: string): MutableProviderModelEntry {
    const entry = this.providers.get(providerName);
    if (!entry) throw new Error(`Unknown provider "${providerName}".`);
    return entry;
  }
}

export function applyProviderModelDefaultsState(
  crewHome: string,
  state: ProviderModelDefaultsState,
): void {
  const changes = state.changes();
  if (changes.length === 0) return;
  writeRawAgentPrefsFile(
    crewHome,
    patchProviderModelDefaults(readRawAgentPrefsFile(crewHome), changes),
  );
}

export function setProviderModelDefault(
  crewHome: string,
  providerName: string,
  model: string | undefined,
): void {
  const normalizedModel = normalizeModel(model);
  writeRawAgentPrefsFile(
    crewHome,
    patchProviderModelDefaults(readRawAgentPrefsFile(crewHome), [{
      providerName,
      ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
    }]),
  );
}

export function patchProviderModelDefaults(
  raw: RawAgentPrefs,
  changes: readonly ProviderModelDefaultChange[],
): RawAgentPrefs {
  const next: RawAgentPrefs = { ...raw };
  for (const change of changes) {
    const providerName = change.providerName.trim();
    if (providerName.length === 0) {
      throw new Error('Provider name must be a non-empty string.');
    }
    const rawEntry = next[providerName];
    if (rawEntry !== undefined && !isRecord(rawEntry)) {
      throw new Error(
        `agents.json entry for "${providerName}" must be an object before crew-mcp can update it.`,
      );
    }
    const entry: Record<string, unknown> = rawEntry === undefined ? {} : { ...rawEntry };
    const model = normalizeModel(change.model);
    if (model === undefined) {
      delete entry.model;
    } else {
      entry.model = model;
    }
    if (Object.keys(entry).length === 0) {
      delete next[providerName];
    } else {
      next[providerName] = entry;
    }
  }
  return next;
}

function normalizeModel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeModels(models: readonly ModelDescriptor[]): ModelDescriptor[] {
  const seen = new Set<string>();
  const out: ModelDescriptor[] = [];
  for (const model of models) {
    const name = model.model.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push({
      ...model,
      model: name,
      displayName: model.displayName.trim() || name,
    });
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
