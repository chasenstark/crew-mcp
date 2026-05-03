import type { WorkflowConfig } from '../workflow/types.js';
import type { PassSummary } from '../state/types.js';
import type { TaskResult } from '../adapters/types.js';
import { buildTieredContext } from '../state/context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAgents(agents: { name: string; capabilities: string[] }[]): string {
  return agents
    .map((a) => `- ${a.name}: capabilities = [${a.capabilities.join(', ')}]`)
    .join('\n');
}

function formatSummaries(summaries: PassSummary[]): string {
  return buildTieredContext(summaries);
}

// ---------------------------------------------------------------------------
// Step 1: DECOMPOSE
// ---------------------------------------------------------------------------

export function buildDecomposePrompt(
  userRequest: string,
  agents: { name: string; capabilities: string[] }[],
  workflow: WorkflowConfig,
): string {
  return `You are a task decomposition engine for a multi-agent coding crew.

Your job is to break down a user's request into discrete, well-scoped tasks that can be assigned to individual agents.

## Available Agents
${formatAgents(agents)}

## Workflow Configuration
Name: ${workflow.name}
Steps: ${workflow.steps.map((s) => `${s.role} (${s.agents.join('|')}) -> ${s.action}`).join(', ')}
Completion strategy: ${workflow.completion.strategy} (fallback: ${workflow.completion.fallback})

## User Request
${userRequest}

## Instructions
1. Analyze the user's request and identify the discrete tasks needed.
2. For each task, determine which agent is best suited based on capabilities.
3. Identify dependencies between tasks (what must complete before what).
4. Estimate complexity for each task (low/medium/high).
5. Suggest an execution order that respects dependencies and maximizes parallelism.

## Rules
- Each task should be independently completable by a single agent.
- Task descriptions should be specific enough for an agent to act on without additional context.
- Always include a review task for implementation tasks when possible.
- Keep the number of tasks reasonable (typically 2-8 for most requests).
- Dependencies should form a DAG (no circular dependencies).
- Scope each task to specific files or areas of the codebase when possible.

Respond with valid JSON matching the required schema.`;
}

// ---------------------------------------------------------------------------
// Step 2: INGEST
// ---------------------------------------------------------------------------

export function buildIngestPrompt(
  taskDescription: string,
  agentResult: TaskResult,
): string {
  const filesInfo = agentResult.filesModified.length > 0
    ? `Files reported modified: ${agentResult.filesModified.join(', ')}`
    : 'No files were explicitly reported as modified.';

  return `You are an output analysis system. Your job is to examine what an agent produced and extract structured information about the results.

## Original Task
${taskDescription}

## Agent Output
Status: ${agentResult.status}
${filesInfo}

### Agent's Response
${agentResult.output}

## Instructions
1. Determine the overall status: did the agent succeed, partially succeed, or fail?
2. Summarize what the agent actually did in 2-3 sentences.
3. List all files that were modified, created, or deleted.
4. Extract key technical decisions the agent made.
5. Identify any concerns — issues, potential bugs, style problems, or risks.
6. Determine if human attention is needed (e.g., ambiguous requirements, security concerns, breaking changes).
7. For review tasks: extract specific findings with severity ratings.

## Rules
- Be objective and thorough in your analysis.
- Flag concerns even if the agent's output looks successful — subtle issues matter.
- The summary should be useful for a future agent that needs to understand what happened.
- Mark needsHumanAttention as true only for genuine blockers or ambiguities, not minor issues.
- For file modifications, prefer the files reported by the agent; supplement with any additional files mentioned in the output.

Respond with valid JSON matching the required schema.`;
}

// ---------------------------------------------------------------------------
// Step 3: SUMMARIZE
// ---------------------------------------------------------------------------

export function buildSummarizePrompt(
  ingestOutput: unknown,
  passNumber: number,
): string {
  const ingestJson = JSON.stringify(ingestOutput, null, 2);

  return `You are a context compression system. Your job is to take the detailed output from the ingest step and compress it into a summary that preserves essential information for future passes.

## Pass Number
${passNumber}

## Ingest Output
${ingestJson}

## Instructions
1. Write a 3-8 sentence summary of what happened during this pass.
2. List any unresolved issues that still need attention.
3. Provide specific context that the next agent or pass would need to know.
4. List all files that are currently in scope (were touched or are relevant).

## Rules
- The summary should be self-contained — a future agent reading only this summary should understand what happened.
- Unresolved issues should be specific and actionable.
- Context for the next pass should include file paths, function names, and specific problems.
- Do not lose critical details during compression — err on the side of including too much rather than too little.
- The passNumber in your response must match the pass number provided.

Respond with valid JSON matching the required schema.`;
}

