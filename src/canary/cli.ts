import { join, resolve } from 'node:path';

import { resolveCrewHome } from '../utils/crew-home.js';
import { resolvePackageRoot } from '../install/skill-renderer.js';
import {
  CANARY_HOSTS,
  runCanary,
  runStubWorker,
  type CanaryHost,
} from './harness.js';

async function main(): Promise<void> {
  if (process.argv[2] === 'stub-worker') {
    await runStubWorker(process.argv[3] ?? '');
    return;
  }
  const packageRoot = resolvePackageRoot();
  const options = parseArgs(process.argv.slice(2));
  const generatedAt = new Date();
  const date = generatedAt.toISOString().slice(0, 10);
  await runCanary({
    packageRoot,
    rotationStatePath: options.rotationStatePath
      ?? join(resolveCrewHome(), 'canary-rotation.json'),
    reportPath: options.reportPath
      ?? join(packageRoot, 'docs', 'status', `canary-${date}.md`),
    trialsPerScenario: options.trials,
    host: options.host,
    now: generatedAt,
  });
}

function parseArgs(args: readonly string[]): {
  host?: CanaryHost;
  trials?: number;
  reportPath?: string;
  rotationStatePath?: string;
} {
  const parsed: {
    host?: CanaryHost;
    trials?: number;
    reportPath?: string;
    rotationStatePath?: string;
  } = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--host') {
      if (!CANARY_HOSTS.includes(value as CanaryHost)) {
        throw new Error(`Unknown host "${value}"; expected ${CANARY_HOSTS.join(', ')}`);
      }
      parsed.host = value as CanaryHost;
    } else if (flag === '--trials') {
      parsed.trials = Number(value);
    } else if (flag === '--report') {
      parsed.reportPath = resolve(value);
    } else if (flag === '--rotation-state') {
      parsed.rotationStatePath = resolve(value);
    } else {
      throw new Error(`Unknown canary option: ${flag}`);
    }
    index += 1;
  }
  return parsed;
}

main().catch((err) => {
  process.stderr.write(`crew canary failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
