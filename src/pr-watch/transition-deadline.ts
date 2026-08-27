export class PrWatchTransitionDeadlineError extends Error {
  constructor(readonly code: 'timeout' | 'cancelled') {
    super(`pr_watch.transition_${code}`);
    this.name = 'PrWatchTransitionDeadlineError';
  }
}

/** Compose the MCP request abort signal with the frozen transition deadline. */
export async function withPrWatchTransitionDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error('pr_watch.invalid_transition_timeout');
  }
  if (options.signal?.aborted) throw new PrWatchTransitionDeadlineError('cancelled');
  const controller = new AbortController();
  let reason: 'timeout' | 'cancelled' | undefined;
  const onAbort = (): void => {
    reason = 'cancelled';
    controller.abort(options.signal?.reason);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    reason = 'timeout';
    controller.abort(new Error('PR-watch transition deadline elapsed'));
  }, timeoutMs);
  timeout.unref?.();
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new PrWatchTransitionDeadlineError(reason ?? 'cancelled');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
