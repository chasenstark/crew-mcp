/**
 * Install manifest — tracks which hosts have crew installed.
 *
 * Lives at ~/.crew/install.json. Read by `crew-mcp verify` and
 * `crew-mcp uninstall` to know what to check and what to remove. Written
 * by `crew-mcp install` after a successful install.
 *
 * Schema versions:
 *   - v1 (legacy): one `skillPath` per host (the umbrella `crew` skill).
 *   - v2 (current): `skills` map keyed by skill id (e.g. `crew`,
 *     `crew:iterate`) plus `writtenPaths` listing every file the
 *     install owns (for thorough uninstall cleanup).
 *
 * v1 manifests still on disk are migrated forward on read: the legacy
 * `skillPath` becomes `skills: { crew: <path> }` and `writtenPaths`
 * is seeded with that single path. v1 is preserved for the back-compat
 * `skillPath` getter so older callers keep working.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ALL_HOST_IDS, type HostId } from './hosts/index.js';

/**
 * Per-host install record. Internally always v2-shaped; the v1->v2
 * read-time migration ensures callers see the same shape regardless
 * of what's on disk.
 */
export interface InstalledTarget {
  /** Host config file path (whatever the adapter wrote to). */
  configPath: string;
  /**
   * BACK-COMPAT: path to the umbrella `crew` SKILL.md. Equal to
   * `skills['crew']` when present. Kept as a top-level field so older
   * callers (uninstall.ts, verify.ts) keep working without a multi-
   * skill rewrite.
   */
  skillPath: string;
  /**
   * Full map of installed skill id → SKILL.md path. The umbrella
   * `crew` skill is always present; `crew:iterate` (and any future
   * sub-skills) appear when their manifest entries are installed.
   */
  skills: Readonly<Record<string, string>>;
  /**
   * Every file/dir crew wrote during install. Authoritative list for
   * thorough uninstall cleanup — uninstall iterates this and prunes
   * empty parent directories up to the host-skills root.
   */
  writtenPaths: readonly string[];
  /** Crew version that did the install. */
  version: string;
  /** ISO 8601 install time. */
  installedAt: string;
  /** The exact command + args the host CLI is configured to spawn. */
  serverCommand: string;
  serverArgs: readonly string[];
  /**
   * Whether the install wrote auto-approval state to bypass per-call
   * tool prompts. Optional for backward-compatibility with v0.2.0-dev
   * manifests that pre-date the field; absent treated as undefined.
   * Used by uninstall to know whether to clear approval state.
   */
  autoApproved?: boolean;
}

/**
 * On-disk v2 manifest. Reader normalizes any v1 file it encounters
 * into this shape before returning. Writer always emits v2.
 *
 * `_extras` holds top-level keys hand-added to the manifest by the
 * user — annotations, custom tooling state, etc. The reader collects
 * any unrecognized top-level key here so the writer can round-trip
 * them. Plan §"v1→v2 migration cases" row: "v1 with extra hand-edited
 * fields → preserve unknown keys at the top level; do not fail."
 */
export interface InstallManifestV2 {
  schemaVersion: 2;
  targets: Partial<Record<HostId, InstalledTarget>>;
  _extras?: Record<string, unknown>;
}

/**
 * Back-compat alias — call sites that still import the v1 type get a
 * v2 manifest with the v1-shaped fields preserved. Safe because v2 is
 * a superset of v1 for everything those callers touch.
 */
export type InstallManifestV1 = InstallManifestV2;

const SCHEMA_VERSION = 2 as const;

export function manifestPath(home: string): string {
  return join(home, '.crew', 'install.json');
}

/**
 * Read the manifest. Returns an empty manifest (no targets) if the file
 * doesn't exist, so callers don't need to handle ENOENT separately.
 * v1 manifests are migrated forward in memory; the on-disk file is not
 * rewritten until the next successful install (uninstall on a v1
 * manifest is supported too — it uses the migrated `skillPath`).
 *
 * Throws on:
 *   - schemaVersion newer than this reader supports
 *   - manifest with no schemaVersion AND no recognizable v1 shape
 *   - unparseable JSON
 */
export async function readInstallManifest(home: string): Promise<InstallManifestV2> {
  const path = manifestPath(home);
  if (!existsSync(path)) {
    return { schemaVersion: SCHEMA_VERSION, targets: {} };
  }
  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown> & {
    schemaVersion?: number;
    targets?: unknown;
  };
  const extras = collectTopLevelExtras(parsed);
  const schemaVersion = parsed.schemaVersion;
  if (schemaVersion === SCHEMA_VERSION) {
    return finalize(normalizeTargets(parsed.targets), extras);
  }
  if (schemaVersion === 1) {
    return finalize(migrateV1Targets(parsed.targets), extras);
  }
  if (typeof schemaVersion === 'number' && schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `install.json schemaVersion=${schemaVersion} is newer than this crew-mcp supports (max ${SCHEMA_VERSION}); upgrade crew-mcp.`,
    );
  }
  throw new Error(
    `install.json schemaVersion=${String(schemaVersion)} is unsupported; expected ${SCHEMA_VERSION}`,
  );
}

/**
 * Top-level keys we own. Anything else is treated as a hand-edited
 * extra and preserved through read+write.
 */
const KNOWN_TOP_LEVEL_KEYS = new Set(['schemaVersion', 'targets']);

function collectTopLevelExtras(parsed: Record<string, unknown>): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(k)) {
      extras[k] = v;
    }
  }
  return extras;
}

function finalize(
  targets: Partial<Record<HostId, InstalledTarget>>,
  extras: Record<string, unknown>,
): InstallManifestV2 {
  const hasExtras = Object.keys(extras).length > 0;
  return {
    schemaVersion: SCHEMA_VERSION,
    targets,
    ...(hasExtras ? { _extras: extras } : {}),
  };
}

/**
 * Write the manifest atomically (tmp + rename). Creates ~/.crew/ if
 * needed. Always writes the current schema version.
 */
export async function writeInstallManifest(
  home: string,
  manifest: InstallManifestV2,
): Promise<void> {
  const path = manifestPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  // Spread the user's top-level extras FIRST so our managed keys
  // (schemaVersion, targets) take precedence on key collision. This
  // preserves hand-edited annotations across read+write without
  // letting them shadow our state.
  const onDisk: Record<string, unknown> = {
    ...(manifest._extras ?? {}),
    schemaVersion: SCHEMA_VERSION,
    targets: manifest.targets,
  };
  await writeFile(tmpPath, JSON.stringify(onDisk, null, 2) + '\n', 'utf-8');
  await rename(tmpPath, path);
}

/**
 * Update a single target's manifest entry. Reads, mutates, writes.
 */
export async function recordInstalledTarget(
  home: string,
  hostId: HostId,
  entry: InstalledTarget,
): Promise<InstallManifestV2> {
  const manifest = await readInstallManifest(home);
  // Reassemble preserving the readonly _extras field that read returned.
  const next: InstallManifestV2 = {
    schemaVersion: SCHEMA_VERSION,
    targets: { ...manifest.targets, [hostId]: entry },
    ...(manifest._extras ? { _extras: manifest._extras } : {}),
  };
  await writeInstallManifest(home, next);
  return next;
}

/**
 * Remove a target from the manifest. Idempotent — missing target is
 * a no-op.
 */
export async function removeInstalledTarget(
  home: string,
  hostId: HostId,
): Promise<InstallManifestV2> {
  const manifest = await readInstallManifest(home);
  if (!manifest.targets[hostId]) return manifest;
  const { [hostId]: _removed, ...rest } = manifest.targets;
  void _removed;
  const next: InstallManifestV2 = {
    schemaVersion: SCHEMA_VERSION,
    targets: rest,
    ...(manifest._extras ? { _extras: manifest._extras } : {}),
  };
  await writeInstallManifest(home, next);
  return next;
}

/**
 * Normalize a v2 `targets` map read from disk. Defensive against
 * hand-edited manifests: missing fields are filled with sensible
 * defaults rather than throwing, so a slightly malformed manifest
 * still uninstalls cleanly.
 */
function normalizeTargets(
  raw: unknown,
): Partial<Record<HostId, InstalledTarget>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Partial<Record<HostId, InstalledTarget>> = {};
  for (const [host, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isKnownHostId(host)) {
      // Plan §"v1→v2 migration cases": unknown host → reject. Throw with
      // a clear message rather than silently dropping the entry —
      // downstream uninstall/verify would then look up HOST_ADAPTERS[host]
      // and crash with a confusing undefined-method error.
      throw new Error(
        `install.json references unknown host "${host}"; known hosts: ${ALL_HOST_IDS.join(', ')}. `
        + 'Remove the unknown entry or upgrade crew-mcp if it ships a new host.',
      );
    }
    const normalized = normalizeTargetEntry(entry);
    if (normalized) {
      out[host] = normalized;
    }
  }
  return out;
}

function isKnownHostId(host: string): host is HostId {
  return (ALL_HOST_IDS as readonly string[]).includes(host);
}

function normalizeTargetEntry(value: unknown): InstalledTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const configPath = typeof v.configPath === 'string' ? v.configPath : '';
  const skillPath = typeof v.skillPath === 'string' ? v.skillPath : '';
  const skillsRaw = v.skills;
  const skills: Record<string, string> = {};
  if (skillsRaw && typeof skillsRaw === 'object' && !Array.isArray(skillsRaw)) {
    for (const [k, val] of Object.entries(skillsRaw as Record<string, unknown>)) {
      if (typeof val === 'string') skills[k] = val;
    }
  }
  // Ensure umbrella crew skill is always reflected in `skills` even if
  // the hand-edited entry only carries the top-level `skillPath`.
  if (skillPath && !skills['crew']) {
    skills['crew'] = skillPath;
  }
  const writtenPathsRaw = v.writtenPaths;
  const writtenPaths = Array.isArray(writtenPathsRaw)
    ? writtenPathsRaw.filter((p): p is string => typeof p === 'string')
    : [];
  if (writtenPaths.length === 0) {
    // Defensive fallback so uninstall has something to walk.
    for (const path of Object.values(skills)) {
      if (path) writtenPaths.push(path);
    }
  }
  return {
    configPath,
    skillPath: skillPath || skills['crew'] || '',
    skills,
    writtenPaths,
    version: typeof v.version === 'string' ? v.version : '',
    installedAt: typeof v.installedAt === 'string' ? v.installedAt : '',
    serverCommand: typeof v.serverCommand === 'string' ? v.serverCommand : '',
    serverArgs: Array.isArray(v.serverArgs)
      ? v.serverArgs.filter((a): a is string => typeof a === 'string')
      : [],
    ...(typeof v.autoApproved === 'boolean' ? { autoApproved: v.autoApproved } : {}),
  };
}

/**
 * Migrate a v1 `targets` map (each entry has `skillPath` but no `skills`
 * or `writtenPaths`) into the v2 shape. The migration is forward-only:
 * we synthesize `skills: { crew: <skillPath> }` and seed
 * `writtenPaths` from the same single path. Uninstall on a v1 manifest
 * still works because the back-compat `skillPath` field is preserved.
 */
function migrateV1Targets(
  raw: unknown,
): Partial<Record<HostId, InstalledTarget>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Partial<Record<HostId, InstalledTarget>> = {};
  for (const [host, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isKnownHostId(host)) {
      throw new Error(
        `install.json (v1) references unknown host "${host}"; known hosts: ${ALL_HOST_IDS.join(', ')}. `
        + 'Remove the unknown entry or upgrade crew-mcp if it ships a new host.',
      );
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const v = entry as Record<string, unknown>;
    const configPath = typeof v.configPath === 'string' ? v.configPath : '';
    const skillPath = typeof v.skillPath === 'string' ? v.skillPath : '';
    const skills: Record<string, string> = {};
    if (skillPath) skills['crew'] = skillPath;
    const writtenPaths = skillPath ? [skillPath] : [];
    out[host] = {
      configPath,
      skillPath,
      skills,
      writtenPaths,
      version: typeof v.version === 'string' ? v.version : '',
      installedAt: typeof v.installedAt === 'string' ? v.installedAt : '',
      serverCommand: typeof v.serverCommand === 'string' ? v.serverCommand : '',
      serverArgs: Array.isArray(v.serverArgs)
        ? v.serverArgs.filter((a): a is string => typeof a === 'string')
        : [],
      ...(typeof v.autoApproved === 'boolean' ? { autoApproved: v.autoApproved } : {}),
    };
  }
  return out;
}
