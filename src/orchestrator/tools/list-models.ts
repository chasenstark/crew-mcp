import { z } from 'zod';

import { modelSelectionSupport } from '../../adapters/model-selection.js';
import type {
  AgentAdapter,
  ModelSelectionSupport,
} from '../../adapters/types.js';
import type { ToolCallReturn, ToolHandlerDeps } from './shared.js';
import { errorContent, jsonContent } from './shared.js';

export const listModelsInputSchema = z.object({
  agent_id: z.string().trim().min(1),
  refresh: z.boolean().optional(),
}).strict();

export type ListModelsInput = z.infer<typeof listModelsInputSchema>;

export const LIST_MODELS_DESCRIPTION =
  'List provider-native model choices for one configured agent. Accepts a canonical agent id or alias; refresh:true bypasses the in-process catalog cache. Returns exact model arguments, display names, provider ids, aliases, default markers, authority, source, and warnings. Unsupported adapters return a capability result; discovery failures never invent models.';

export interface ListModelsOutput {
  readonly agent_id: string;
  readonly support: ModelSelectionSupport;
  readonly catalog_source?: string;
  readonly authoritative: boolean;
  readonly models: readonly {
    readonly model: string;
    readonly display_name: string;
    readonly provider_id?: string;
    readonly aliases?: readonly string[];
    readonly is_default?: boolean;
  }[];
  readonly checked_at: string;
  readonly warnings?: readonly string[];
}

export async function listModelsToolHandler(
  args: ListModelsInput,
  deps: Pick<ToolHandlerDeps, 'registry'>,
): Promise<ToolCallReturn> {
  const known = deps.registry.get(args.agent_id);
  if (!known) {
    const valid = deps.registry.listAvailable()
      .flatMap((adapter) => [adapter.name, ...(adapter.aliases ?? [])])
      .sort();
    return errorContent(
      `Unknown agent_id "${args.agent_id}". Available agents: ${valid.join(', ') || '(none registered)'}`,
    );
  }

  const adapter = await loadAdapter(deps.registry, args.agent_id, known);
  if (!adapter.listModels) {
    return jsonContent(unsupportedCatalog(adapter));
  }
  const catalog = await adapter.listModels({ refresh: args.refresh === true });
  const output: ListModelsOutput = {
    agent_id: adapter.name,
    support: catalog.support,
    catalog_source: catalog.source,
    authoritative: catalog.authoritative,
    models: catalog.models.map((model) => ({
      model: model.model,
      display_name: model.displayName,
      ...(model.providerId !== undefined ? { provider_id: model.providerId } : {}),
      ...(model.aliases !== undefined ? { aliases: [...model.aliases] } : {}),
      ...(model.isDefault !== undefined ? { is_default: model.isDefault } : {}),
    })),
    checked_at: catalog.checkedAt,
    ...(catalog.warnings !== undefined ? { warnings: [...catalog.warnings] } : {}),
  };
  return jsonContent(output);
}

async function loadAdapter(
  registry: ToolHandlerDeps['registry'],
  requested: string,
  fallback: AgentAdapter,
): Promise<AgentAdapter> {
  return await registry.load(requested) ?? fallback;
}

function unsupportedCatalog(adapter: AgentAdapter): ListModelsOutput {
  return {
    agent_id: adapter.name,
    support: modelSelectionSupport(adapter),
    authoritative: true,
    models: [],
    checked_at: new Date().toISOString(),
    warnings: [`Agent "${adapter.name}" does not support explicit model selection.`],
  };
}
