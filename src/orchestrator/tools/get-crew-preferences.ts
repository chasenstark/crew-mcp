import { z } from 'zod';

import type { AgentPrefsMap } from '../../agent-prefs/store.js';
import type {
  IterateAgentDefaultsConfig,
  PanelAgentDefaultsConfig,
  WorkflowAgentDefaultsConfig,
} from '../../workflow/types.js';
import { loadWorkflowConfig } from '../../workflow/loader.js';
import {
  type AgentListSource,
} from './list-agents.js';
import type { ToolCallReturn, ToolHandlerDeps } from './shared.js';
import { errorContent, jsonContent } from './shared.js';

export const getCrewPreferencesInputSchema = z.object({
  scope: z.enum(['iterate', 'panel', 'all']).optional(),
}).strict();

export type GetCrewPreferencesInput = z.infer<typeof getCrewPreferencesInputSchema>;

export const GET_CREW_PREFERENCES_DESCRIPTION =
  'Read user-set agent defaults for iterate and review panels. Captains call this before agent-pick prompts to honor workflow.agentDefaults preferences; unresolved ids are returned as warnings instead of throwing.';

export interface GetCrewPreferencesOutput {
  readonly iterate?: IterateAgentDefaultsConfig;
  readonly panel?: PanelAgentDefaultsConfig;
  readonly warnings?: readonly string[];
}

export interface GetCrewPreferencesContext {
  readonly projectRoot: string;
  readonly registry: AgentListSource;
  readonly agentPrefs?: AgentPrefsMap;
  readonly refresh?: boolean;
  readonly loadConfig?: (projectRoot: string) => { workflow: { agentDefaults?: WorkflowAgentDefaultsConfig } };
}

export async function getCrewPreferencesToolHandler(
  args: GetCrewPreferencesInput,
  deps: Pick<ToolHandlerDeps, 'projectRoot' | 'registry' | 'readAgentPrefs'>,
): Promise<ToolCallReturn> {
  const agentPrefs = deps.readAgentPrefs();
  try {
    const out = await getCrewPreferencesHandler(args, {
      projectRoot: deps.projectRoot,
      registry: deps.registry,
      agentPrefs,
    });
    return jsonContent(out);
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }
}

export async function getCrewPreferencesHandler(
  args: unknown,
  ctx: GetCrewPreferencesContext,
): Promise<GetCrewPreferencesOutput> {
  const input = getCrewPreferencesInputSchema.parse(args ?? {});
  const scope = input.scope ?? 'all';
  const config = (ctx.loadConfig ?? loadWorkflowConfig)(ctx.projectRoot);
  const defaults = config.workflow.agentDefaults;
  if (!defaults) return {};

  const output: {
    iterate?: IterateAgentDefaultsConfig;
    panel?: PanelAgentDefaultsConfig;
    warnings?: string[];
  } = {};
  if ((scope === 'iterate' || scope === 'all') && hasIterateDefaults(defaults.iterate)) {
    output.iterate = cloneIterateDefaults(defaults.iterate);
  }
  if ((scope === 'panel' || scope === 'all') && hasPanelDefaults(defaults.panel)) {
    output.panel = clonePanelDefaults(defaults.panel);
  }
  if (!output.iterate && !output.panel) return {};

  const knownIds = listAgentIds(ctx.registry);
  const warnings = buildWarnings(output, knownIds);
  output.warnings = warnings;
  return output;
}

function listAgentIds(registry: AgentListSource): Set<string> {
  const ids = new Set<string>();
  for (const agent of registry.listAvailable()) {
    ids.add(agent.name);
    for (const alias of agent.aliases ?? []) {
      ids.add(alias);
    }
  }
  return ids;
}

function buildWarnings(
  output: Pick<GetCrewPreferencesOutput, 'iterate' | 'panel'>,
  knownIds: Set<string>,
): string[] {
  const warnings: string[] = [];
  const warnIfMissing = (label: string, id: string): void => {
    if (knownIds.has(id)) return;
    warnings.push(
      `${label} '${id}' is not in list_agents (agent unavailable or uninstalled)`,
    );
  };

  if (output.iterate?.implementer) {
    warnIfMissing('preferred implementer', output.iterate.implementer);
  }
  for (const id of output.iterate?.reviewers ?? []) {
    warnIfMissing('preferred iterate reviewer', id);
  }
  for (const id of output.iterate?.banList ?? []) {
    warnIfMissing('iterate banList entry', id);
  }
  for (const id of output.panel?.reviewers ?? []) {
    warnIfMissing('preferred panel reviewer', id);
  }
  for (const id of output.panel?.banList ?? []) {
    warnIfMissing('panel banList entry', id);
  }
  return warnings;
}

function hasIterateDefaults(
  defaults: IterateAgentDefaultsConfig | undefined,
): defaults is IterateAgentDefaultsConfig {
  return defaults !== undefined
    && (
      defaults.implementer !== undefined
      || defaults.reviewers !== undefined
      || defaults.banList !== undefined
    );
}

function hasPanelDefaults(
  defaults: PanelAgentDefaultsConfig | undefined,
): defaults is PanelAgentDefaultsConfig {
  return defaults !== undefined
    && (
      defaults.reviewers !== undefined
      || defaults.banList !== undefined
    );
}

function cloneIterateDefaults(
  defaults: IterateAgentDefaultsConfig,
): IterateAgentDefaultsConfig {
  return {
    ...(defaults.implementer !== undefined ? { implementer: defaults.implementer } : {}),
    ...(defaults.reviewers !== undefined ? { reviewers: [...defaults.reviewers] } : {}),
    ...(defaults.banList !== undefined ? { banList: [...defaults.banList] } : {}),
  };
}

function clonePanelDefaults(
  defaults: PanelAgentDefaultsConfig,
): PanelAgentDefaultsConfig {
  return {
    ...(defaults.reviewers !== undefined ? { reviewers: [...defaults.reviewers] } : {}),
    ...(defaults.banList !== undefined ? { banList: [...defaults.banList] } : {}),
  };
}
