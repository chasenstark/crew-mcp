import { resolveRepoContextMode, type AgentAdapter } from './types.js';

/** Capability warning only: do not read files or alter the supplied prompt. */
export function repoContextWarnings(
  adapter: Pick<AgentAdapter, 'name' | 'repoContextMode'>,
): string[] {
  if (resolveRepoContextMode(adapter) !== 'supplied-text') return [];
  return [
    `repo_context.supplied_text_only: Agent "${adapter.name}" receives only supplied text and cannot inspect or edit checkout files. Include required text in the prompt or peer messages, including on continuation, or choose a workspace-capable agent.`,
  ];
}
