import { ModelId } from '../workflow/models.js';
import { isLoopbackApiBase, resolveOpenAiApiBase } from './unmetered.js';
import { classifyHttpFailure, classifyTextFailure } from './failure-classifier.js';
import type {
  AdapterModelCatalog,
  AdapterModelResolution,
  AgentAdapter,
  AgentStrength,
  HealthCheckOptions,
  HealthCheckResult,
  Task,
  TaskResult,
} from './types.js';
import { HealthCheckCache } from '../utils/health-check-cache.js';
import { findCatalogModel, ModelCatalogCache } from './model-selection.js';
import { listOpenAiCompatibleModels } from './openai-models.js';

class OpenAiCompatibleHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`OpenAI-compatible request failed (${status}): ${body}`);
  }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content?: string;
  name?: string;
}

const DEFAULT_OPENAI_COMPATIBLE_TIMEOUT_MS = 10 * 60 * 1000;

export interface OpenAiCompatibleAdapterOptions {
  name: string;
  model?: string;
  apiBase?: string;
  apiKey?: string;
  strengths?: AgentStrength[];
  useWhen?: string;
}

export class OpenAiCompatibleAdapter implements AgentAdapter {
  readonly name: string;
  readonly strengths: AgentStrength[];
  readonly useWhen?: string;
  readonly supportsJsonSchema = false;
  readonly enforcesReadOnly = false;
  readonly modelSelectionSupport = 'catalog' as const;
  readonly unmetered: boolean;
  // Chat completions do not provide an adapter-level filesystem change list.
  readonly filesModifiedReliable = false;
  readonly captainCapabilities = {
    supportsStructuredDecisions: true,
    supportsPauseForUserInput: false,
  };

  private readonly defaultModel: string;
  private readonly apiBase: string;
  private readonly apiKey?: string;
  private readonly healthCheckCache = new HealthCheckCache();
  private readonly modelCatalogCache = new ModelCatalogCache();

  constructor(options: OpenAiCompatibleAdapterOptions) {
    this.name = options.name;
    this.defaultModel = options.model ?? ModelId.QWEN;
    this.apiBase = resolveOpenAiApiBase(options.apiBase);
    this.unmetered = isLoopbackApiBase(this.apiBase);
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.CREW_OPENAI_API_KEY;
    // Empty default — what an OpenAI-compatible endpoint is "good at"
    // depends entirely on the model wired up. Users declare strengths in
    // their agent config or via ~/.crew/agents.json.
    this.strengths = options.strengths ?? [];
    this.useWhen = options.useWhen;
  }

  async execute(task: Task): Promise<TaskResult> {
    let response: any;
    try {
      response = await this.chatCompletion({
        model: task.constraints?.model ?? this.defaultModel,
        messages: [{ role: 'user', content: task.prompt }],
        timeoutMs: task.constraints?.timeout,
        signal: task.constraints?.signal,
      });
    } catch (error: unknown) {
      if (task.constraints?.signal?.aborted || isAbortError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        output: message,
        filesModified: [],
        status: 'error',
        failure: error instanceof OpenAiCompatibleHttpError
          ? classifyHttpFailure({
              status: error.status,
              body: error.body,
              retryAfterSeconds: error.retryAfterSeconds,
            })
          : classifyTextFailure(message, { defaultKind: 'transient' }),
        metadata: {
          rawEvents: [
            error instanceof OpenAiCompatibleHttpError
              ? { status: error.status, body: error.body }
              : { error: message },
          ],
        },
      };
    }

    const message = response?.choices?.[0]?.message;
    const content = typeof message?.content === 'string' ? message.content : '';
    if (task.onOutput && content) {
      task.onOutput(content);
    }

    return {
      output: content,
      filesModified: [],
      status: content ? 'success' : 'partial',
      metadata: {
        ...(typeof response?.model === 'string' && response.model.trim().length > 0
          ? { observedModel: response.model.trim() }
          : {}),
        rawEvents: [response],
      },
    };
  }

  async listModels(options?: { refresh?: boolean }): Promise<AdapterModelCatalog> {
    return this.modelCatalogCache.get(options, async () => {
      const discovered = await listOpenAiCompatibleModels(this.apiBase, this.apiKey);
      const ids = discovered.ok ? [...discovered.models] : [];
      if (!ids.includes(this.defaultModel)) ids.unshift(this.defaultModel);
      return {
        support: this.modelSelectionSupport,
        source: discovered.ok ? 'provider-api' : 'configured',
        authoritative: discovered.ok,
        models: ids.map((model) => ({
          model,
          displayName: model,
          ...(model === this.defaultModel ? { isDefault: true } : {}),
        })),
        checkedAt: new Date().toISOString(),
        ...(!discovered.ok
          ? { warnings: [`OpenAI-compatible model discovery failed: ${discovered.reason}`] }
          : {}),
      };
    });
  }

  async resolveModel(
    requested: string,
    options?: { refreshOnMiss?: boolean },
  ): Promise<AdapterModelResolution> {
    if (requested === this.defaultModel) {
      return {
        ok: true,
        argument: requested,
        displayName: requested,
        validation: 'configured',
      };
    }
    let catalog = await this.listModels();
    let descriptor = findCatalogModel(catalog, requested);
    if (!descriptor && options?.refreshOnMiss === true) {
      catalog = await this.listModels({ refresh: true });
      descriptor = findCatalogModel(catalog, requested);
    }
    if (descriptor) {
      return {
        ok: true,
        argument: descriptor.model,
        displayName: descriptor.displayName,
        validation: descriptor.model === this.defaultModel ? 'configured' : 'catalog',
      };
    }
    if (!catalog.authoritative) {
      return {
        ok: false,
        code: 'model_selection.discovery_unavailable',
        message: `model_selection.discovery_unavailable: could not verify model "${requested}" for agent "${this.name}". ${catalog.warnings?.join(' ') ?? ''}`.trim(),
      };
    }
    return {
      ok: false,
      code: 'model_selection.unknown',
      message: `model_selection.unknown: agent "${this.name}" does not advertise model "${requested}". Call list_models for current choices.`,
    };
  }

  async healthCheck(options?: HealthCheckOptions): Promise<HealthCheckResult> {
    return this.healthCheckCache.get(options, () => this.probeHealth());
  }

  private async probeHealth(): Promise<HealthCheckResult> {
    try {
      const response = await fetch(`${this.apiBase}/models`, {
        headers: this.apiKey
          ? { Authorization: `Bearer ${this.apiKey}` }
          : undefined,
      });
      if (response.ok) {
        return {
          available: true,
          authenticated: true,
        };
      }
      return {
        available: false,
        authenticated: false,
        error: `HTTP ${response.status} from ${this.apiBase}/models`,
      };
    } catch (error: unknown) {
      return {
        available: false,
        authenticated: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async chatCompletion(params: {
    model: string;
    messages: ChatMessage[];
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<any> {
    if (params.signal?.aborted) {
      throw params.signal.reason ?? new Error('OpenAI-compatible request aborted');
    }

    const timeoutMs = resolveOpenAiCompatibleTimeoutMs(params.timeoutMs);
    const controller = timeoutMs > 0 ? new AbortController() : undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let removeAbortListener: (() => void) | undefined;
    if (controller && params.signal) {
      const onAbort = () => controller.abort(params.signal?.reason);
      params.signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => params.signal?.removeEventListener('abort', onAbort);
    }
    if (controller) {
      timeoutHandle = setTimeout(
        () => controller.abort('OpenAI-compatible request timed out'),
        timeoutMs,
      );
      timeoutHandle.unref?.();
    }

    try {
      const response = await fetch(`${this.apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: params.model,
          messages: params.messages,
        }),
        signal: controller?.signal ?? params.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new OpenAiCompatibleHttpError(
          response.status,
          text,
          parseRetryAfterSeconds(response.headers?.get?.('retry-after') ?? undefined),
        );
      }

      return response.json();
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      removeAbortListener?.();
    }
  }
}

function resolveOpenAiCompatibleTimeoutMs(requested: number | undefined): number {
  if (requested !== undefined) {
    return Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
  }
  const raw = process.env.CREW_OPENAI_COMPATIBLE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_OPENAI_COMPATIBLE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function parseRetryAfterSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds);
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
