import { z, ZodError } from 'zod';
import type { AgentAdapter } from '../adapters/types.js';
import { extractJson } from './json-parse.js';
import { logger } from './logger.js';

/**
 * Execute a prompt against an adapter and validate the response against a Zod schema.
 *
 * If the adapter supports native JSON schema (e.g. Claude Code's --json-schema flag),
 * it delegates to adapter.executeWithSchema directly. Otherwise it falls back to
 * prompted JSON: the schema description is appended to the prompt, the raw text
 * output is parsed with extractJson, and validated with Zod. On validation failure
 * it retries up to maxRetries times, appending the validation errors to help the LLM
 * self-correct.
 */
export async function executeWithValidation<T extends z.ZodType>(
  adapter: AgentAdapter,
  prompt: string,
  schema: T,
  options?: {
    workingDirectory?: string;
    maxRetries?: number;
    model?: string;
    signal?: AbortSignal;
    timeout?: number;
  },
): Promise<z.infer<T>> {
  const maxRetries = options?.maxRetries ?? 1;
  logger.debug('executeWithValidation started', {
    adapter: adapter.name,
    supportsJsonSchema: adapter.supportsJsonSchema,
    workingDirectory: options?.workingDirectory ?? process.cwd(),
    maxRetries,
    promptChars: prompt.length,
  });

  // Fast path: adapter natively supports JSON schema output
  if (adapter.supportsJsonSchema && adapter.executeWithSchema) {
    try {
      return await adapter.executeWithSchema(prompt, schema, {
        workingDirectory: options?.workingDirectory,
        model: options?.model,
        signal: options?.signal,
        timeout: options?.timeout,
      });
    } catch (error: unknown) {
      logger.error('executeWithValidation fast path failed', {
        adapter: adapter.name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // Slow path: prompted JSON with validation + retry
  let lastError: unknown;
  let currentPrompt = prompt + '\n\nRespond with ONLY valid JSON matching this schema. No extra text.\n';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    logger.debug('executeWithValidation prompted JSON attempt', {
      adapter: adapter.name,
      attempt: attempt + 1,
      maxAttempts: maxRetries + 1,
    });
    const result = await adapter.execute({
      prompt: currentPrompt,
      context: {
        workingDirectory: options?.workingDirectory ?? process.cwd(),
      },
      constraints: {
        model: options?.model,
        signal: options?.signal,
        timeout: options?.timeout,
      },
    });

    if (result.status === 'error') {
      logger.error('executeWithValidation adapter returned error status', {
        adapter: adapter.name,
        attempt: attempt + 1,
        outputPreview: result.output.slice(0, 400),
      });
      throw new Error(`Agent execution failed: ${result.output}`);
    }

    try {
      const raw = extractJson(result.output);
      return schema.parse(raw) as z.infer<T>;
    } catch (err: unknown) {
      logger.warn('executeWithValidation parse/validation failed', {
        adapter: adapter.name,
        attempt: attempt + 1,
        error: err instanceof Error ? err.message : String(err),
        outputPreview: result.output.slice(0, 400),
      });
      lastError = err;

      if (attempt < maxRetries) {
        // Build a retry prompt with validation errors
        let errorMessage = 'Unknown validation error';
        if (err instanceof ZodError) {
          errorMessage = err.issues
            .map((issue) => `- ${issue.path.join('.')}: ${issue.message}`)
            .join('\n');
        } else if (err instanceof Error) {
          errorMessage = err.message;
        }

        currentPrompt =
          prompt +
          '\n\nYour previous response had validation errors:\n' +
          errorMessage +
          '\n\nPlease fix the errors and respond with ONLY valid JSON. No extra text.\n';
      }
    }
  }

  throw lastError;
}
