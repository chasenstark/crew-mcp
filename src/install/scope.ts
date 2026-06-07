export type InstallScope = 'global' | 'project';

export function parseInstallScope(raw: unknown): InstallScope {
  if (raw === undefined || raw === null || raw === '') return 'global';
  if (raw === 'global' || raw === 'project') return raw;
  throw new Error(
    `Invalid --scope "${String(raw)}"; expected "global" or "project".`,
  );
}
