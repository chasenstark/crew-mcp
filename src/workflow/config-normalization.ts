export type ConfigScopeValue = 'project' | 'global';

export function normalizeProfileName(profile: string): string {
  const normalized = profile.trim();
  if (!normalized) {
    throw new Error('Profile name is required.');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error(`Invalid profile "${profile}". Use only letters, numbers, ".", "_", or "-".`);
  }
  return normalized;
}

export function parseConfigScope(scope: string): ConfigScopeValue {
  if (scope === 'project' || scope === 'global') return scope;
  throw new Error(`Invalid scope "${scope}". Expected "project" or "global".`);
}
