import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { execa } from 'execa';

import { resolvePackageRoot } from '../../install/skill-renderer.js';

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

const GATEKEEPER_PROMPT = `✓ CrewTail.app installed at ~/Applications/CrewTail.app
✓ Registered crew-tail:// scheme with LaunchServices

Next: macOS Gatekeeper needs to approve the handler.
Because the app isn't signed with an Apple Developer ID,
macOS will block the first launch with a dialog that says
roughly:

    "CrewTail.app cannot be opened because Apple cannot
     check it for malicious software."

To approve it, you'll need to:
  1. Click "Done" on that dialog
  2. Open System Settings → Privacy & Security
  3. Scroll to Security and click "Open Anyway" next to CrewTail
  4. Confirm in the next dialog

After that, clicking crew-tail:// links from dispatch output
will open Terminal directly with no further prompts.

Skip this and clicking a tail link later will trigger the
same dialog, but mid-workflow rather than at install time.

Trigger the Gatekeeper dialog now? [Y/n]`;

export interface InstallTailHandlerOptions {
  readonly yes?: boolean;
  readonly gatekeeper?: boolean;
  readonly triggerGatekeeper?: boolean;
  readonly home?: string;
  readonly packageRoot?: string;
  readonly isInteractive?: boolean;
  readonly stdin?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

export interface InstallTailHandlerResult {
  readonly appPath: string;
  readonly verified: boolean;
}

export async function installTailHandlerCommand(
  opts: InstallTailHandlerOptions = {},
): Promise<InstallTailHandlerResult> {
  const home = opts.home ?? homedir();
  const appPath = join(home, 'Applications', 'CrewTail.app');
  const output = opts.output ?? process.stderr;

  if (process.platform !== 'darwin') {
    throw new Error('crew-mcp install-tail-handler is macOS-only.');
  }

  if (opts.triggerGatekeeper) {
    await triggerGatekeeper(appPath, output);
    return { appPath, verified: await verifyLaunchServices(output) };
  }

  const packageRoot = resolvePackageRoot(opts.packageRoot);
  const scriptDir = join(packageRoot, 'scripts', 'tail-handler');
  const buildScript = join(scriptDir, 'build.sh');
  const installScript = join(scriptDir, 'install.sh');
  if (!existsSync(buildScript) || !existsSync(installScript)) {
    throw new Error(`Could not locate tail handler scripts under ${scriptDir}`);
  }

  const build = await execa('/bin/bash', [buildScript], { cwd: scriptDir });
  const builtAppPath = lastStdoutLine(build.stdout) ?? join(scriptDir, 'build', 'CrewTail.app');
  await execa('/bin/bash', [installScript, builtAppPath], {
    cwd: scriptDir,
    env: { HOME: home, CREW_TAIL_INSTALL_DIR: join(home, 'Applications') },
  });

  if (opts.gatekeeper === false) {
    write(output, 'Skipped. Run `crew-mcp install-tail-handler --trigger-gatekeeper` later, or just click a tail link and approve the dialog when it appears.\n');
    return { appPath, verified: await verifyLaunchServices(output) };
  }

  const shouldTrigger = await shouldTriggerGatekeeper(opts, output);
  if (shouldTrigger) {
    await triggerGatekeeper(appPath, output);
  } else {
    write(output, 'Skipped. Run `crew-mcp install-tail-handler --trigger-gatekeeper` later, or just click a tail link and approve the dialog when it appears.\n');
  }

  return { appPath, verified: await verifyLaunchServices(output) };
}

async function shouldTriggerGatekeeper(
  opts: InstallTailHandlerOptions,
  output: NodeJS.WritableStream,
): Promise<boolean> {
  const stdin = opts.stdin ?? process.stdin;
  const isInteractive = opts.isInteractive ?? Boolean((stdin as { isTTY?: boolean }).isTTY);

  write(output, GATEKEEPER_PROMPT);
  if (opts.yes || !isInteractive) {
    write(output, '\n');
    return true;
  }

  const rl = createInterface({ input: stdin, output });
  try {
    const answer = (await rl.question(' ')).trim().toLowerCase();
    return answer.length === 0 || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function triggerGatekeeper(
  appPath: string,
  output: NodeJS.WritableStream,
): Promise<void> {
  if (!existsSync(appPath)) {
    throw new Error(`CrewTail.app is not installed at ${appPath}. Run \`crew-mcp install-tail-handler\` first.`);
  }
  await execa('open', [appPath]);
  await delay(1_000);
  write(output, "If you didn't see a dialog, the app may already be approved — try clicking a `crew-tail://` link to confirm.\n");
}

async function verifyLaunchServices(output: NodeJS.WritableStream): Promise<boolean> {
  const result = await execa(LSREGISTER, ['-dump'], { reject: false });
  const haystack = `${result.stdout}\n${result.stderr ?? ''}`;
  const verified = haystack.includes('crew-tail');
  if (verified) {
    write(output, '✓ Verified crew-tail:// scheme registration with LaunchServices.\n');
  } else {
    write(output, 'Could not verify crew-tail:// registration via `lsregister -dump | grep crew-tail`.\n');
  }
  return verified;
}

function lastStdoutLine(stdout: string): string | undefined {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
}

function write(output: NodeJS.WritableStream, text: string): void {
  output.write(text);
}
