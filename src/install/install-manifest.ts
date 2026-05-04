/**
 * Install manifest — tracks which hosts have crew installed.
 *
 * Lives at ~/.crew/install.json. Read by `crew verify` and
 * `crew uninstall` to know what to check and what to remove. Written
 * by `crew install` after a successful install.
 *
 * Schema versioned (v1). Future bumps add a migration; today the
 * reader throws on unknown versions so a stale manifest fails loud.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { HostId } from './hosts/index.js';

export interface InstalledTarget {
  /** Host config file path (whatever the adapter wrote to). */
  configPath: string;
  /** Skill file path (whatever the adapter wrote to). */
  skillPath: string;
  /** Crew version that did the install. */
  version: string;
  /** ISO 8601 install time. */
  installedAt: string;
  /** The exact command + args the host CLI is configured to spawn. */
  serverCommand: string;
  serverArgs: readonly string[];
}

export interface InstallManifestV1 {
  schemaVersion: 1;
  targets: Partial<Record<HostId, InstalledTarget>>;
}

const SCHEMA_VERSION = 1 as const;

export function manifestPath(home: string): string {
  return join(home, '.crew', 'install.json');
}

/**
 * Read the manifest. Returns an empty manifest (no targets) if the file
 * doesn't exist, so callers don't need to handle ENOENT separately.
 * Throws if the file exists but has an unknown schemaVersion or shape.
 */
export async function readInstallManifest(home: string): Promise<InstallManifestV1> {
  const path = manifestPath(home);
  if (!existsSync(path)) {
    return { schemaVersion: SCHEMA_VERSION, targets: {} };
  }
  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<InstallManifestV1>;
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `install.json schemaVersion=${String(parsed.schemaVersion)} is unsupported; expected ${SCHEMA_VERSION}`,
    );
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    targets: parsed.targets ?? {},
  };
}

/**
 * Write the manifest atomically (tmp + rename). Creates ~/.crew/ if
 * needed.
 */
export async function writeInstallManifest(
  home: string,
  manifest: InstallManifestV1,
): Promise<void> {
  const path = manifestPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeFile(tmpPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  await rename(tmpPath, path);
}

/**
 * Update a single target's manifest entry. Reads, mutates, writes.
 */
export async function recordInstalledTarget(
  home: string,
  hostId: HostId,
  entry: InstalledTarget,
): Promise<InstallManifestV1> {
  const manifest = await readInstallManifest(home);
  manifest.targets[hostId] = entry;
  await writeInstallManifest(home, manifest);
  return manifest;
}

/**
 * Remove a target from the manifest. Idempotent — missing target is
 * a no-op.
 */
export async function removeInstalledTarget(
  home: string,
  hostId: HostId,
): Promise<InstallManifestV1> {
  const manifest = await readInstallManifest(home);
  if (manifest.targets[hostId]) {
    delete manifest.targets[hostId];
    await writeInstallManifest(home, manifest);
  }
  return manifest;
}
