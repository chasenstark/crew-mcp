import { isIP } from 'node:net';

export const DEFAULT_OPENAI_BASE_URL = 'http://127.0.0.1:11434/v1';

export function resolveOpenAiApiBase(configApiBase?: string): string {
  return (configApiBase ?? process.env.CREW_OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL)
    .replace(/\/+$/, '');
}

export function isLoopbackApiBase(apiBase: string | undefined): boolean {
  if (apiBase === undefined) return false;

  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    return false;
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const ipVersion = isIP(host);
  if (ipVersion === 4) return host.startsWith('127.');
  if (ipVersion === 6) return host === '::1';
  return false;
}
