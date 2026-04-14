const STEP_LABELS: Record<string, string> = {
  decompose: 'Decomposing request into tasks...',
  dispatch: 'Crafting agent prompt...',
  ingest: 'Analyzing agent output...',
  summarize: 'Summarizing pass...',
  judge: 'Evaluating quality...',
  report: 'Generating report...',
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function shorten(text: string, max = 100): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}...`;
}

function taskLabel(data?: Record<string, unknown>): string | undefined {
  const description = asString(data?.taskDescription);
  if (description) {
    const firstLine = description.split('\n')[0].replace(/\s+/g, ' ').trim();
    return shorten(firstLine, 60);
  }
  return asString(data?.taskId);
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

export function getStepLabel(step: string): string {
  return STEP_LABELS[step] ?? `Running ${step}...`;
}

export function formatStepStart(step: string, data?: Record<string, unknown>): string {
  const label = taskLabel(data);
  const pass = asNumber(data?.pass);

  switch (step) {
    case 'decompose':
      return 'breaking the request into executable tasks';
    case 'dispatch':
      if (label && pass !== undefined) return `preparing instructions for "${label}" (pass ${pass})`;
      if (label) return `preparing instructions for "${label}"`;
      return 'preparing instructions for the assigned agent';
    case 'ingest':
      return label ? `analyzing output from "${label}"` : 'analyzing agent output';
    case 'summarize':
      return label ? `compressing results for "${label}"` : 'compressing results for the next pass';
    case 'judge':
      return label ? `evaluating completion criteria for "${label}"` : 'evaluating completion criteria';
    case 'report':
      return 'assembling the final response';
    default:
      return 'running';
  }
}

export function formatStepComplete(step: string, data?: Record<string, unknown>): string {
  switch (step) {
    case 'decompose': {
      const taskCount = asNumber(data?.taskCount);
      if (taskCount === undefined) return 'task plan created';
      return `planned ${taskCount} ${pluralize(taskCount, 'task', 'tasks')}`;
    }
    case 'dispatch': {
      const label = taskLabel(data);
      const pass = asNumber(data?.pass);
      if (label && pass !== undefined) return `prompt ready for "${label}" (pass ${pass})`;
      if (label) return `prompt ready for "${label}"`;
      return 'agent prompt prepared';
    }
    case 'ingest': {
      const status = asString(data?.status);
      const summary = asString(data?.summary);
      const needsHumanAttention = asBoolean(data?.needsHumanAttention);
      const parts: string[] = [];

      if (status) parts.push(`status: ${status}`);
      if (summary) parts.push(shorten(summary));
      if (needsHumanAttention) parts.push('human input requested');

      return parts.length > 0 ? parts.join(' | ') : 'agent output ingested';
    }
    case 'summarize': {
      const summary = asString(data?.summary);
      const unresolvedIssueCount = asNumber(data?.unresolvedIssueCount);
      const parts: string[] = [];

      if (summary) parts.push(shorten(summary));
      if (unresolvedIssueCount !== undefined) {
        parts.push(
          `${unresolvedIssueCount} ${pluralize(unresolvedIssueCount, 'unresolved issue', 'unresolved issues')}`,
        );
      }

      return parts.length > 0 ? parts.join(' | ') : 'pass summary recorded';
    }
    case 'judge': {
      const decision = asString(data?.decision);
      const reasoning = asString(data?.reasoning);
      const isLooping = asBoolean(data?.isLooping);
      const parts: string[] = [];

      if (decision) parts.push(`decision: ${decision}`);
      if (reasoning) parts.push(shorten(reasoning));
      if (isLooping) parts.push('loop detected');

      return parts.length > 0 ? parts.join(' | ') : 'evaluation complete';
    }
    case 'report': {
      const passCount = asNumber(data?.passCount);
      if (passCount === undefined) return 'final report generated';
      return `final report generated from ${passCount} ${pluralize(passCount, 'pass', 'passes')}`;
    }
    default:
      return 'step completed';
  }
}
