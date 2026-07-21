import type { AgentAdapter } from '../../adapters/types.js';
import type { FullConfig } from '../../workflow/types.js';

export interface DispatchPolicyRegistry {
  get(name: string): AgentAdapter | undefined;
}

export interface AgentBanMatch {
  readonly canonicalAgentId: string;
  readonly configuredAgentId: string;
  readonly preference: 'workflow.agentDefaults.iterate.banList' | 'workflow.agentDefaults.panel.banList';
}

export function canonicalAgentId(
  registry: DispatchPolicyRegistry,
  agentId: string,
): string {
  return registry.get(agentId)?.name ?? agentId;
}

export function findAgentBanMatch(args: {
  readonly registry: DispatchPolicyRegistry;
  readonly config: FullConfig;
  readonly agentId: string;
  readonly scopes: readonly ('iterate' | 'panel')[];
}): AgentBanMatch | undefined {
  const canonical = canonicalAgentId(args.registry, args.agentId);
  for (const scope of args.scopes) {
    const banList = args.config.workflow.agentDefaults?.[scope]?.banList ?? [];
    for (const configuredAgentId of banList) {
      if (canonicalAgentId(args.registry, configuredAgentId) === canonical) {
        return {
          canonicalAgentId: canonical,
          configuredAgentId,
          preference: `workflow.agentDefaults.${scope}.banList`,
        };
      }
    }
  }
  return undefined;
}

export function isSameHostAgent(args: {
  readonly registry: DispatchPolicyRegistry;
  readonly agentId: string;
  readonly sameHostAgentId: string | undefined;
}): boolean {
  if (args.sameHostAgentId === undefined) return false;
  return canonicalAgentId(args.registry, args.agentId)
    === canonicalAgentId(args.registry, args.sameHostAgentId);
}

export function agentBannedMessage(
  match: AgentBanMatch,
  prefix = '',
): string {
  return `agent_banned: ${prefix}agent "${match.canonicalAgentId}" matches `
    + `${match.preference} entry "${match.configuredAgentId}". Ask the user to lift the ban, `
    + 'then retry with ban_override:true.';
}

export function banOverrideWarning(match: AgentBanMatch): string {
  return `agent_banned override: agent "${match.canonicalAgentId}" matched ${match.preference} `
    + `entry "${match.configuredAgentId}"; ban_override:true was supplied.`;
}

export function sameHostOverrideWarning(agentId: string): string {
  return `same_host_reviewer override: agent "${agentId}" matches the current host; `
    + 'same_host_ok:true was supplied.';
}
