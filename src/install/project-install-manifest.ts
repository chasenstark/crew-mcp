import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { atomicWrite } from '../utils/atomic-write.js';
import { ALL_HOST_IDS, type HostId } from './hosts/index.js';
import type { InstalledTarget } from './install-manifest.js';
import type { InstallScope } from './scope.js';

export interface ProjectInstalledTarget extends InstalledTarget {
  readonly permissionsPath?: string;
}

export interface ProjectInstallManifest {
  readonly schemaVersion: 1;
  readonly scope: Extract<InstallScope, 'project'>;
  readonly targets: Partial<Record<HostId, ProjectInstalledTarget>>;
  readonly _extras?: Record<string, unknown>;
}

const PROJECT_SCHEMA_VERSION = 1 as const;
const PROJECT_MANIFEST_RELATIVE_PATH = '.crew/install.project.json';
const KNOWN_TOP_LEVEL_KEYS = new Set(['schemaVersion', 'scope', 'targets']);

export function projectManifestPath(repoRoot: string): string {
  return join(repoRoot, PROJECT_MANIFEST_RELATIVE_PATH);
}

export async function readProjectInstallManifest(
  repoRoot: string,
): Promise<ProjectInstallManifest> {
  const path = projectManifestPath(repoRoot);
  if (!existsSync(path)) {
    return emptyProjectManifest();
  }

  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown> & {
    schemaVersion?: number;
    scope?: string;
    targets?: unknown;
  };

  if (parsed.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new Error(
      `install.project.json schemaVersion=${String(parsed.schemaVersion)} is unsupported; `
      + `expected ${PROJECT_SCHEMA_VERSION}`,
    );
  }
  if (parsed.scope !== 'project') {
    throw new Error(
      `install.project.json scope=${String(parsed.scope)} is unsupported; expected "project"`,
    );
  }

  const extras = collectTopLevelExtras(parsed);
  return finalizeProjectManifest(normalizeProjectTargets(parsed.targets), extras);
}

export async function writeProjectInstallManifest(
  repoRoot: string,
  manifest: ProjectInstallManifest,
): Promise<void> {
  const onDisk: Record<string, unknown> = {
    ...(manifest._extras ?? {}),
    schemaVersion: PROJECT_SCHEMA_VERSION,
    scope: 'project',
    targets: manifest.targets,
  };
  atomicWrite(projectManifestPath(repoRoot), JSON.stringify(onDisk, null, 2) + '\n');
}

export async function recordProjectInstalledTarget(
  repoRoot: string,
  hostId: HostId,
  entry: ProjectInstalledTarget,
): Promise<ProjectInstallManifest> {
  const manifest = await readProjectInstallManifest(repoRoot);
  const next: ProjectInstallManifest = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    scope: 'project',
    targets: { ...manifest.targets, [hostId]: entry },
    ...(manifest._extras ? { _extras: manifest._extras } : {}),
  };
  await writeProjectInstallManifest(repoRoot, next);
  return next;
}

export async function removeProjectInstalledTarget(
  repoRoot: string,
  hostId: HostId,
): Promise<ProjectInstallManifest> {
  const manifest = await readProjectInstallManifest(repoRoot);
  if (!manifest.targets[hostId]) return manifest;
  const { [hostId]: _removed, ...rest } = manifest.targets;
  void _removed;
  const next: ProjectInstallManifest = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    scope: 'project',
    targets: rest,
    ...(manifest._extras ? { _extras: manifest._extras } : {}),
  };
  await writeProjectInstallManifest(repoRoot, next);
  return next;
}

export function toRepoRelativePath(repoRoot: string, filePath: string): string {
  const rel = relative(repoRoot, filePath);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Project install path is outside repo root: ${filePath}`);
  }
  return rel.split(sep).join('/');
}

export function resolveProjectPath(repoRoot: string, manifestPathValue: string): string {
  if (isAbsolute(manifestPathValue)) return manifestPathValue;
  return resolve(repoRoot, manifestPathValue);
}

export function relativizeProjectTarget(
  repoRoot: string,
  entry: ProjectInstalledTarget,
): ProjectInstalledTarget {
  return {
    ...entry,
    configPath: toRepoRelativePath(repoRoot, entry.configPath),
    skillPath: entry.skillPath ? toRepoRelativePath(repoRoot, entry.skillPath) : '',
    skills: mapValues(entry.skills, (path) => toRepoRelativePath(repoRoot, path)),
    writtenPaths: entry.writtenPaths.map((path) => toRepoRelativePath(repoRoot, path)),
    ...(entry.sharedSkills
      ? { sharedSkills: mapValues(entry.sharedSkills, (path) => toRepoRelativePath(repoRoot, path)) }
      : {}),
    ...(entry.permissionsPath
      ? { permissionsPath: toRepoRelativePath(repoRoot, entry.permissionsPath) }
      : {}),
  };
}

export function absolutizeProjectTarget(
  repoRoot: string,
  entry: ProjectInstalledTarget,
): ProjectInstalledTarget {
  return {
    ...entry,
    configPath: resolveProjectPath(repoRoot, entry.configPath),
    skillPath: entry.skillPath ? resolveProjectPath(repoRoot, entry.skillPath) : '',
    skills: mapValues(entry.skills, (path) => resolveProjectPath(repoRoot, path)),
    writtenPaths: entry.writtenPaths.map((path) => resolveProjectPath(repoRoot, path)),
    ...(entry.sharedSkills
      ? { sharedSkills: mapValues(entry.sharedSkills, (path) => resolveProjectPath(repoRoot, path)) }
      : {}),
    ...(entry.permissionsPath
      ? { permissionsPath: resolveProjectPath(repoRoot, entry.permissionsPath) }
      : {}),
  };
}

function emptyProjectManifest(): ProjectInstallManifest {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    scope: 'project',
    targets: {},
  };
}

function collectTopLevelExtras(parsed: Record<string, unknown>): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      extras[key] = value;
    }
  }
  return extras;
}

function finalizeProjectManifest(
  targets: Partial<Record<HostId, ProjectInstalledTarget>>,
  extras: Record<string, unknown>,
): ProjectInstallManifest {
  const hasExtras = Object.keys(extras).length > 0;
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    scope: 'project',
    targets,
    ...(hasExtras ? { _extras: extras } : {}),
  };
}

function normalizeProjectTargets(
  raw: unknown,
): Partial<Record<HostId, ProjectInstalledTarget>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Partial<Record<HostId, ProjectInstalledTarget>> = {};
  for (const [host, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isKnownHostId(host)) {
      throw new Error(
        `install.project.json references unknown host "${host}"; known hosts: ${ALL_HOST_IDS.join(', ')}. `
        + 'Remove the unknown entry or upgrade crew-mcp if it ships a new host.',
      );
    }
    const normalized = normalizeProjectTargetEntry(entry);
    if (normalized) {
      out[host] = normalized;
    }
  }
  return out;
}

function isKnownHostId(host: string): host is HostId {
  return (ALL_HOST_IDS as readonly string[]).includes(host);
}

function normalizeProjectTargetEntry(value: unknown): ProjectInstalledTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const configPath = typeof v.configPath === 'string' ? v.configPath : '';
  const skillPath = typeof v.skillPath === 'string' ? v.skillPath : '';
  const skills = stringRecord(v.skills);
  if (skillPath && !skills.crew) {
    skills.crew = skillPath;
  }
  const writtenPaths = stringArray(v.writtenPaths);
  if (writtenPaths.length === 0) {
    writtenPaths.push(...Object.values(skills));
  }
  const sharedSkills = stringRecord(v.sharedSkills);
  return {
    configPath,
    skillPath: skillPath || skills.crew || '',
    skills,
    writtenPaths,
    ...(Object.keys(sharedSkills).length > 0 ? { sharedSkills } : {}),
    version: typeof v.version === 'string' ? v.version : '',
    installedAt: typeof v.installedAt === 'string' ? v.installedAt : '',
    serverCommand: typeof v.serverCommand === 'string' ? v.serverCommand : '',
    serverArgs: stringArray(v.serverArgs),
    ...(typeof v.autoApproved === 'boolean' ? { autoApproved: v.autoApproved } : {}),
    ...(typeof v.permissionsPath === 'string' ? { permissionsPath: v.permissionsPath } : {}),
  };
}

function stringRecord(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function stringArray(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === 'string')
    : [];
}

function mapValues(
  input: Readonly<Record<string, string>>,
  map: (value: string) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = map(value);
  }
  return out;
}
