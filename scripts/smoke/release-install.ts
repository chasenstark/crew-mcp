/**
 * Package/install smoke for CI and release preparation. Run after the normal
 * build; compile this helper separately so it is not part of the npm tarball.
 * Project installs use the packed CLI; global installs use explicit home seams.
 * This checks disk wiring; provider auth, live hooks, and wakes need live smoke.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installCommand } from '../../src/cli/commands/install.js';
import { verifyCommand } from '../../src/cli/commands/verify.js';

const repoRoot = resolve(process.cwd());
const fixtureRoot = await mkdtemp(join(tmpdir(), 'crew-release-smoke-'));
const npmEnv = { ...process.env, npm_config_cache: join(fixtureRoot, 'npm-cache') };

try {
  const packOutput = execFileSync('npm', [
    'pack', '--json', '--pack-destination', fixtureRoot,
  ], { cwd: repoRoot, env: npmEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const packs = JSON.parse(packOutput) as Array<{ filename: string }>;
  assert.equal(packs.length, 1, 'Expected one package tarball');
  const prefix = join(fixtureRoot, 'install');
  execFileSync('npm', [
    'install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund',
    join(fixtureRoot, packs[0].filename),
  ], { env: npmEnv, stdio: 'inherit' });

  const packageRoot = join(prefix, 'node_modules', 'crew-mcp');
  const packedPackage = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    version: string;
    bin: Record<string, string>;
  };
  const cli = join(packageRoot, 'dist', 'index.js');
  const version = execFileSync(process.execPath, [cli, '--version'], {
    cwd: fixtureRoot, encoding: 'utf8',
  }).trim();
  assert.equal(version, packedPackage.version);
  for (const [name, path] of Object.entries(packedPackage.bin)) {
    await access(join(packageRoot, path), constants.R_OK);
    await access(join(prefix, 'node_modules', '.bin', name), constants.X_OK);
  }

  // Exercise the actual packed CLI and its lazy chunks, using project scope
  // so host config stays inside the fixture without changing HOME.
  const projectEnv = { ...npmEnv, CREW_HOME: join(fixtureRoot, 'project-state') };
  execFileSync('git', ['init', '--quiet', prefix], { stdio: 'inherit' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const command of ['install', 'verify']) {
      execFileSync(process.execPath, [
        cli, command, '--scope', 'project', '--target', 'claude-code,codex,agy',
      ], { cwd: prefix, env: projectEnv, stdio: 'inherit' });
    }
  }

  const fixtureHome = join(fixtureRoot, 'host-home');
  const crewHome = join(fixtureHome, '.crew');
  const installOptions = {
    target: 'claude-code,codex',
    home: fixtureHome,
    crewHome,
    packageRoot,
    forceWithoutBinary: true,
    skipRunningCheck: true,
    resolveCrewBinary: () => ({ command: process.execPath, args: [cli, 'serve'] }),
    isCrewWaitOnPath: () => false,
    resolveCrewWaitBinary: () => join(prefix, 'node_modules', '.bin', 'crew-wait'),
  };
  // A second install checks that generated config and manifest remain valid.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const installed = await installCommand(installOptions);
    assert.deepEqual(installed.skipped, []);
    assert.deepEqual(installed.installed.sort(), ['claude-code', 'codex']);
    const report = await verifyCommand({ home: fixtureHome, crewHome, packageRoot });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.targets.length, 2);
  }
  console.log(`Package ${version}: bins, packed CLI project install/verify, and global fixture install/verify passed.`);
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
