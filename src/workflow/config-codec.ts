import YAML from 'yaml';
import type {
  FullConfig,
  IterateAgentDefaultsConfig,
  PanelAgentDefaultsConfig,
  WorkflowAgentDefaultsConfig,
} from './types.js';

const DEFAULT_CONFIG: FullConfig = {
  workflow: {},
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function mergeIterateAgentDefaults(
  base: IterateAgentDefaultsConfig | undefined,
  override: IterateAgentDefaultsConfig | undefined,
): IterateAgentDefaultsConfig | undefined {
  const merged = {
    ...(base ?? {}),
    ...(override ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergePanelAgentDefaults(
  base: PanelAgentDefaultsConfig | undefined,
  override: PanelAgentDefaultsConfig | undefined,
): PanelAgentDefaultsConfig | undefined {
  const merged = {
    ...(base ?? {}),
    ...(override ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeAgentDefaults(
  base: WorkflowAgentDefaultsConfig | undefined,
  override: WorkflowAgentDefaultsConfig | undefined,
): WorkflowAgentDefaultsConfig | undefined {
  const iterate = mergeIterateAgentDefaults(base?.iterate, override?.iterate);
  const panel = mergePanelAgentDefaults(base?.panel, override?.panel);
  const merged = {
    ...(iterate ? { iterate } : {}),
    ...(panel ? { panel } : {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function parseOptionalAgentId(raw: unknown, path: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new Error(`${path} must be a string`);
  }
  return raw;
}

function parseOptionalAgentIdList(raw: unknown, path: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`${path} must be an array of strings`);
  }
  return raw.map((value, index) => {
    if (typeof value !== 'string') {
      throw new Error(`${path}[${index}] must be a string`);
    }
    return value;
  });
}

function parseAgentDefaults(raw: unknown): WorkflowAgentDefaultsConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  const root = asObject(raw);
  const iterateRoot = asObject(root.iterate);
  const panelRoot = asObject(root.panel);
  const iterate = omitUndefined({
    implementer: parseOptionalAgentId(
      iterateRoot.implementer,
      'workflow.agent_defaults.iterate.implementer',
    ),
    reviewers: parseOptionalAgentIdList(
      iterateRoot.reviewers,
      'workflow.agent_defaults.iterate.reviewers',
    ),
    banList: parseOptionalAgentIdList(
      iterateRoot.ban_list ?? iterateRoot.banList,
      'workflow.agent_defaults.iterate.ban_list',
    ),
  }) as unknown as IterateAgentDefaultsConfig;
  const panel = omitUndefined({
    reviewers: parseOptionalAgentIdList(
      panelRoot.reviewers,
      'workflow.agent_defaults.panel.reviewers',
    ),
    banList: parseOptionalAgentIdList(
      panelRoot.ban_list ?? panelRoot.banList,
      'workflow.agent_defaults.panel.ban_list',
    ),
  }) as unknown as PanelAgentDefaultsConfig;

  const out = {
    ...(Object.keys(iterate).length > 0 ? { iterate } : {}),
    ...(Object.keys(panel).length > 0 ? { panel } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function serializeAgentDefaults(
  defaults: WorkflowAgentDefaultsConfig | undefined,
): unknown {
  if (!defaults) return undefined;
  const iterate = defaults.iterate
    ? omitUndefined({
        implementer: defaults.iterate.implementer,
        reviewers: defaults.iterate.reviewers,
        ban_list: defaults.iterate.banList,
      })
    : undefined;
  const panel = defaults.panel
    ? omitUndefined({
        reviewers: defaults.panel.reviewers,
        ban_list: defaults.panel.banList,
      })
    : undefined;
  const out = omitUndefined({
    iterate: iterate && Object.keys(iterate).length > 0 ? iterate : undefined,
    panel: panel && Object.keys(panel).length > 0 ? panel : undefined,
  });
  return Object.keys(out).length > 0 ? out : undefined;
}

export function mergeConfigs(base: FullConfig, override: FullConfig): FullConfig {
  return {
    workflow: {
      agentDefaults: mergeAgentDefaults(
        base.workflow.agentDefaults,
        override.workflow.agentDefaults,
      ),
    },
  };
}

/**
 * Parse `.crew/workflow.yaml`. Only `workflow.agent_defaults` is read —
 * every other block a v0.1-era file may still carry (steps, captain,
 * presets, error_handling, agents) is ignored on parse and dropped on
 * the next serialize.
 */
export function parseWorkflowYaml(yamlContent: string): FullConfig {
  const parsed = asObject(YAML.parse(yamlContent));
  const parsedWorkflow = asObject(parsed.workflow);
  const parsedAgentDefaults = parseAgentDefaults(
    parsedWorkflow.agent_defaults ?? parsedWorkflow.agentDefaults,
  );

  return {
    workflow: {
      agentDefaults: parsedAgentDefaults,
    },
  };
}

export function serializeWorkflowYaml(config: FullConfig): string {
  const agentDefaults = serializeAgentDefaults(config.workflow.agentDefaults);
  const yamlObject = {
    workflow: {
      ...(agentDefaults !== undefined ? { agent_defaults: agentDefaults } : {}),
    },
  };

  return YAML.stringify(yamlObject, {
    lineWidth: 0,
  });
}

export function getDefaultConfig(): FullConfig {
  return structuredClone(DEFAULT_CONFIG);
}
