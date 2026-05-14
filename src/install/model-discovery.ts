export type ModelDiscoveryResult =
  | { readonly ok: true; readonly models: readonly string[] }
  | { readonly ok: false; readonly reason: string };

const DEFAULT_TIMEOUT_MS = 5_000;

export async function listOpenAiCompatibleModels(
  apiBase: string,
  apiKey: string | undefined,
  opts: { timeoutMs?: number } = {},
): Promise<ModelDiscoveryResult> {
  const modelsUrl = `${apiBase.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort('model discovery timed out'),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const response = await fetch(modelsUrl, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status} from ${modelsUrl}` };
    }
    const parsed = await response.json() as unknown;
    const models = parseModelIds(parsed);
    if (models.length === 0) {
      return { ok: false, reason: 'response did not contain data: [{ id }] models' };
    }
    return { ok: true, models };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseModelIds(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
  }
  return ids;
}
