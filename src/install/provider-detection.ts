export interface ProviderProbeResult {
  readonly reachable: boolean;
  readonly url: string;
  readonly reason?: string;
}

export const OLLAMA_DEFAULT_URL = 'http://localhost:11434';
export const OLLAMA_DEFAULT_API_BASE = `${OLLAMA_DEFAULT_URL}/v1`;
export const LM_STUDIO_DEFAULT_API_BASE = 'http://localhost:1234/v1';

const DEFAULT_TIMEOUT_MS = 2_000;

export async function detectOllama(
  opts: { timeoutMs?: number } = {},
): Promise<ProviderProbeResult> {
  return probeProvider(OLLAMA_DEFAULT_URL, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

export async function detectLmStudio(
  opts: { timeoutMs?: number } = {},
): Promise<ProviderProbeResult> {
  return probeProvider(LM_STUDIO_DEFAULT_API_BASE, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

async function probeProvider(url: string, timeoutMs: number): Promise<ProviderProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('provider probe timed out'), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.ok) {
      return { reachable: true, url };
    }
    return {
      reachable: false,
      url,
      reason: `HTTP ${response.status} from ${url}`,
    };
  } catch (err) {
    return {
      reachable: false,
      url,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}
