import { resolveRepoContextMode, type AgentAdapter } from './types.js';

/** Capability warning only: do not read files or alter the supplied prompt. */
export function repoContextWarnings(
  adapter: Pick<AgentAdapter, 'name' | 'repoContextMode' | 'acceptsRepoContext'>,
): string[] {
  if (resolveRepoContextMode(adapter) !== 'supplied-text') return [];
  if (adapter.acceptsRepoContext === true) {
    return [
      `repo_context.supplied_text_only: Agent "${adapter.name}" receives supplied text and cannot inspect or edit checkout files. Read-only runs receive bounded automatic review context when allowed; inspect omission warnings and attach context_files for additional files, including on continuation. This is not a complete-workspace or conversational-resume guarantee.`,
    ];
  }
  return [
    `repo_context.supplied_text_only: Agent "${adapter.name}" receives only supplied text and cannot inspect or edit checkout files. Include required text in the prompt or peer messages, including on continuation, or choose a workspace-capable agent.`,
  ];
}
