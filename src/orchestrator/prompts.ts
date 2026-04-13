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
  return `You are a task decomposition engine for a multi-agent orchestration system.

Your job is to break down a user's request into discrete, well-scoped tasks that can be assigned to individual agents.

## Available Agents
${formatAgents(agents)}

## Workflow Configuration
Name: ${workflow.name}
Steps: ${workflow.steps.map((s) => `${s.role} (${s.agent}) -> ${s.action}`).join(', ')}
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
// Step 2: DISPATCH
// ---------------------------------------------------------------------------

export function buildDispatchPrompt(
  taskDescription: string,
  taskRole: string,
  previousSummaries: PassSummary[],
  passNumber: number,
): string {
  const context = formatSummaries(previousSummaries);

  return `You are a prompt engineering system. Your job is to craft the perfect prompt for an agent that will execute a specific task.

## Task
Description: ${taskDescription}
Role: ${taskRole}
Pass number: ${passNumber}

## Previous Context
${context}

## Instructions
1. Write a comprehensive prompt that gives the agent everything it needs to complete the task.
2. The prompt should be self-contained — the agent has no memory of previous interactions.
3. Include specific file paths, function names, or patterns to look for when available from context.
4. For review tasks: tell the agent exactly what to look for and how to report findings.
5. For implementation tasks: be specific about what to create/modify and acceptance criteria.
6. For fix/iterate tasks: include the specific issues found in previous passes that need resolution.

## Rules
- The agent prompt should be direct and actionable.
- Include all relevant context from previous passes so the agent can continue without information loss.
- Set clear success criteria so the output can be evaluated.
- Specify expected output files or artifacts.
- If this is a subsequent pass (passNumber > 1), focus the prompt on unresolved issues from prior passes.

Respond with valid JSON matching the required schema.`;
}

// ---------------------------------------------------------------------------
// Step 3: INGEST
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
// Step 4: SUMMARIZE
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

// ---------------------------------------------------------------------------
// Step 5: JUDGE
// ---------------------------------------------------------------------------

export function buildJudgePrompt(
  ingestOutput: unknown,
  previousSummaries: PassSummary[],
  currentPass: number,
  maxPasses: number,
): string {
  const ingestJson = JSON.stringify(ingestOutput, null, 2);
  const context = formatSummaries(previousSummaries);

  return `You are a quality gate. Your job is to decide whether the current task is complete, needs another iteration, or requires human input.

## Current Pass: ${currentPass} of ${maxPasses}

## Ingest Output (Current Pass)
${ingestJson}

## Previous Pass Summaries
${context}

## Instructions
1. Evaluate the quality and completeness of the current pass.
2. Decide one of:
   - "done": The task is satisfactorily complete. Minor issues can be accepted.
   - "iterate": There are critical or major issues that need another pass to fix.
   - "ask_user": There is genuine ambiguity or a decision that only a human can make.
3. If iterating, list the specific issues that need fixes with severity ratings.
4. If done, list any minor issues that are being accepted.
5. Detect if the same issues are repeating across passes (looping).

## Rules
- Be pragmatic: perfection is not the goal. Accept "good enough" work.
- Only choose "iterate" for critical or major issues. Minor style issues should be accepted.
- If this is pass ${currentPass} of ${maxPasses} and issues are minor, prefer "done".
- If the same issues appear in multiple passes, set isLooping to true and consider "done" or "ask_user".
- "ask_user" is for genuine ambiguity, not for issues that can be resolved by another pass.
- On the final pass (${maxPasses}), strongly prefer "done" unless there are critical errors.

Respond with valid JSON matching the required schema.`;
}

// ---------------------------------------------------------------------------
// Step 6: REPORT
// ---------------------------------------------------------------------------

export function buildReportPrompt(
  summaries: PassSummary[],
  userRequest: string,
): string {
  const context = formatSummaries(summaries);

  return `You are a report generator. Your job is to produce a clear, human-readable summary of everything that happened during the orchestration workflow.

## Original User Request
${userRequest}

## Pass Summaries
${context}

## Instructions
Write a natural language report that:
1. Starts with a one-sentence overview of what was accomplished.
2. Lists the key changes made (files created, modified, decisions taken).
3. Notes any unresolved issues or accepted compromises.
4. Ends with suggested next steps if applicable.

## Rules
- Write in a clear, conversational tone.
- Be concise but thorough — the user wants to understand what happened without reading logs.
- Use bullet points for lists of changes.
- If there were issues or concerns, be transparent about them.
- Do NOT wrap the response in JSON. Respond with plain text/markdown.`;
}
