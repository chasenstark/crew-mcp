export type ProviderName = 'claude' | 'codex' | 'gemini' | 'local';

export type ProviderTransport =
  | 'native'
  | 'stateful-resume'
  | 'prefix-cached'
  | 'adapter'
  | 'fallback';

export type PathTaken = ProviderTransport;

export interface ProviderSession {
  provider: ProviderName;
  transport: ProviderTransport;
  sessionId?: string;
  threadId?: string;
  cliVersion?: string;
  toolNamespace: string;
  toolSchemaHash: string;
  mcpConfigPath?: string;
  startedAt: string;
  lastTurnAt?: string;
}

interface ParsedCliVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

export function buildCliVersionTag(cliName: string, version: string): string {
  return `${cliName}@${version}`;
}

export function parseCliVersionTag(tag: string): {
  name: string;
  version: ParsedCliVersion;
} | null {
  const atIndex = tag.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === tag.length - 1) return null;
  const name = tag.slice(0, atIndex).trim();
  const versionText = tag.slice(atIndex + 1).trim();
  if (!name || !versionText) return null;

  const parsed = parseSemver(versionText);
  if (!parsed) return null;

  return {
    name,
    version: parsed,
  };
}

export function parseSemver(rawVersion: string): ParsedCliVersion | null {
  const cleaned = rawVersion.trim().replace(/^v/i, '');
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: rawVersion.trim(),
  };
}

export function isCliVersionCompatible(
  sessionCliVersion: string | undefined,
  detectedCliVersion: string | undefined,
): boolean {
  if (!sessionCliVersion || !detectedCliVersion) return false;

  const stored = parseCliVersionTag(sessionCliVersion);
  const detected = parseCliVersionTag(detectedCliVersion);

  if (!stored || !detected) return false;
  if (stored.name !== detected.name) return false;

  if (stored.version.major === 0 || detected.version.major === 0) {
    return stored.version.raw === detected.version.raw;
  }

  return (
    stored.version.major === detected.version.major
    && stored.version.minor === detected.version.minor
  );
}
