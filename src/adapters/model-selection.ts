import type {
  AdapterModelCatalog,
  AgentAdapter,
  ModelSelectionRecord,
  ModelSelectionSupport,
} from './types.js';

export interface WireModelSelection {
  readonly source: ModelSelectionRecord['source'];
  readonly requested_model?: string;
  readonly model_argument?: string;
  readonly display_name?: string;
  readonly validation: ModelSelectionRecord['validation'];
  readonly inherited_from_turn?: number;
  readonly observed_model?: string;
}

/** Optional on legacy/test adapters means honestly unsupported. */
export function modelSelectionSupport(
  adapter: Pick<AgentAdapter, 'modelSelectionSupport'>,
): ModelSelectionSupport {
  return adapter.modelSelectionSupport ?? 'unsupported';
}

export function modelSelectionToWire(
  record: ModelSelectionRecord,
): WireModelSelection {
  return {
    source: record.source,
    ...(record.requestedModel !== undefined
      ? { requested_model: record.requestedModel }
      : {}),
    ...(record.modelArgument !== undefined
      ? { model_argument: record.modelArgument }
      : {}),
    ...(record.displayName !== undefined
      ? { display_name: record.displayName }
      : {}),
    validation: record.validation,
    ...(record.inheritedFromTurn !== undefined
      ? { inherited_from_turn: record.inheritedFromTurn }
      : {}),
    ...(record.observedModel !== undefined
      ? { observed_model: record.observedModel }
      : {}),
  };
}

export function latestModelSelection(
  prompts: readonly { readonly modelSelection?: ModelSelectionRecord }[],
): ModelSelectionRecord | undefined {
  return prompts.at(-1)?.modelSelection;
}

/** Small per-adapter successful-catalog cache; refresh always bypasses it. */
export class ModelCatalogCache {
  private cached: AdapterModelCatalog | undefined;
  private inFlight: Promise<AdapterModelCatalog> | undefined;

  async get(
    options: { readonly refresh?: boolean } | undefined,
    load: () => Promise<AdapterModelCatalog>,
  ): Promise<AdapterModelCatalog> {
    if (options?.refresh !== true && this.cached !== undefined) {
      return this.cached;
    }
    if (this.inFlight !== undefined) return this.inFlight;

    const request = load().then((catalog) => {
      if (isCacheableCatalog(catalog)) this.cached = catalog;
      return catalog;
    });
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) this.inFlight = undefined;
    }
  }

  peek(): AdapterModelCatalog | undefined {
    return this.cached;
  }

  clear(): void {
    this.cached = undefined;
  }
}

function isCacheableCatalog(catalog: AdapterModelCatalog): boolean {
  if (catalog.support === 'unsupported' || catalog.authoritative) return true;
  // Claude's successful documented-alias catalog is deliberately
  // non-authoritative because account entitlement remains provider-owned.
  // Cache that stable result, but never pin a degraded partial catalog with a
  // discovery warning (for example missing fable after a transient --help
  // failure, or only the configured OpenAI-compatible default after /models
  // was unavailable).
  return catalog.models.length > 0 && (catalog.warnings?.length ?? 0) === 0;
}

export function findCatalogModel(
  catalog: AdapterModelCatalog,
  requested: string,
) {
  return catalog.models.find((descriptor) =>
    descriptor.model === requested || descriptor.aliases?.includes(requested));
}
