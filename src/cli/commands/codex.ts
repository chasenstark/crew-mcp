import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';

import {
  CODEX_BRIDGE_FILE_ENV,
  CODEX_BRIDGE_SCHEMA_VERSION,
  type CodexBridgeDescriptor,
} from '../../codex/app-server-bridge.js';
import {
  CODEX_REMOTE_TOKEN_ENV,
  withoutCodexCaptainEnvironment,
} from '../../codex/environment.js';
import { resolveCrewHome } from '../../utils/crew-home.js';

export { CODEX_REMOTE_TOKEN_ENV } from '../../codex/environment.js';
const LOOPBACK_HOST = '127.0.0.1';
const STARTUP_TIMEOUT_MS = 15_000;
const SERVER_STOP_GRACE_MS = 2_000;

export interface CodexCommandOptions {
  readonly args?: readonly string[];
  readonly crewHome?: string;
  readonly codexBinary?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly reservePort?: () => Promise<number>;
  readonly spawnProcess?: typeof spawn;
  readonly waitForReady?: (url: string, child: ChildProcess) => Promise<void>;
}

export interface CodexBridgeRuntime {
  readonly url: string;
  readonly token: string;
  readonly tokenFile: string;
  readonly bridgeFile: string;
  cleanup(): void;
}

export async function codexCommand(options: CodexCommandOptions = {}): Promise<number> {
  const args = [...(options.args ?? [])];
  rejectOwnedRemoteFlags(args);
  const crewHome = options.crewHome ?? resolveCrewHome();
  const codexBinary = options.codexBinary ?? 'codex';
  const spawnProcess = options.spawnProcess ?? spawn;
  const port = await (options.reservePort ?? reserveLoopbackPort)();
  const runtime = createCodexBridgeRuntime(crewHome, port);
  const baseEnv = options.env ?? process.env;
  const childBaseEnv = withoutCodexCaptainEnvironment(baseEnv);
  const serverEnv = { ...childBaseEnv };
  const tuiEnv = {
    ...childBaseEnv,
    [CODEX_REMOTE_TOKEN_ENV]: runtime.token,
  };
  let server: ChildProcess | undefined;
  let tui: ChildProcess | undefined;
  let forwardedSignal: NodeJS.Signals | undefined;
  let serverOutput = (): string => '';
  const forwardSignal = (signal: NodeJS.Signals): void => {
    forwardedSignal = signal;
    if (tui && tui.exitCode === null && tui.signalCode === null) tui.kill(signal);
    if (server && server.exitCode === null && server.signalCode === null) server.kill(signal);
  };
  const onSigint = (): void => forwardSignal('SIGINT');
  const onSigterm = (): void => forwardSignal('SIGTERM');
  const onSighup = (): void => forwardSignal('SIGHUP');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  if (process.platform !== 'win32') process.on('SIGHUP', onSighup);

  try {
    server = spawnProcess(
      codexBinary,
      buildCodexAppServerArgs(runtime),
      {
        env: serverEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    serverOutput = captureOutputTail(server);
    await waitForSpawn(server, 'Codex App Server');
    if (forwardedSignal !== undefined) return 1;
    try {
      await (options.waitForReady ?? waitForAppServerReady)(runtime.url, server);
    } catch (error) {
      if (forwardedSignal !== undefined) return 1;
      const suffix = serverOutput().trim();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}`
        + (suffix ? `\n${suffix}` : ''),
      );
    }
    if (forwardedSignal !== undefined) return 1;

    tui = spawnProcess(
      codexBinary,
      buildCodexTuiArgs(runtime.url, args),
      {
        env: tuiEnv,
        stdio: 'inherit',
      },
    );
    await waitForSpawn(tui, 'Codex TUI');
    const firstExit = await Promise.race([
      waitForExit(tui).then(
        (code) => ({ child: 'tui' as const, code }),
        (error: unknown) => ({ child: 'tui' as const, error }),
      ),
      waitForExit(server).then(
        (code) => ({ child: 'server' as const, code }),
        (error: unknown) => ({ child: 'server' as const, error }),
      ),
    ]);
    if ('error' in firstExit) {
      throw new Error(
        `${firstExit.child === 'server' ? 'Codex App Server' : 'Codex TUI'} failed: `
        + (firstExit.error instanceof Error ? firstExit.error.message : String(firstExit.error)),
      );
    }
    if (firstExit.child === 'server') {
      await stopChild(tui);
      if (forwardedSignal !== undefined) return firstExit.code;
      const suffix = serverOutput().trim();
      throw new Error(
        `Codex App Server exited unexpectedly with code ${firstExit.code}`
        + (suffix ? `\n${suffix}` : ''),
      );
    }
    return firstExit.code;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    if (process.platform !== 'win32') process.off('SIGHUP', onSighup);
    if (tui) await stopChild(tui);
    if (server) await stopChild(server);
    runtime.cleanup();
  }
}

export function buildCodexAppServerArgs(runtime: CodexBridgeRuntime): string[] {
  return [
    'app-server',
    '-c',
    `mcp_servers.crew.env.${CODEX_BRIDGE_FILE_ENV}=${JSON.stringify(runtime.bridgeFile)}`,
    '--listen',
    runtime.url,
    '--ws-auth',
    'capability-token',
    '--ws-token-file',
    runtime.tokenFile,
  ];
}

export function buildCodexTuiArgs(url: string, args: readonly string[]): string[] {
  return [
    '--remote',
    url,
    '--remote-auth-token-env',
    CODEX_REMOTE_TOKEN_ENV,
    ...args,
  ];
}

export function createCodexBridgeRuntime(
  crewHome: string,
  port: number,
): CodexBridgeRuntime {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid Codex App Server port: ${port}`);
  }
  const runtimeDir = join(crewHome, 'codex-host');
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(runtimeDir, 0o700);
  const id = randomUUID();
  const tokenFile = join(runtimeDir, `${id}.token`);
  const bridgeFile = join(runtimeDir, `${id}.json`);
  const token = randomBytes(32).toString('base64url');
  const url = `ws://${LOOPBACK_HOST}:${port}`;
  const descriptor: CodexBridgeDescriptor = {
    schemaVersion: CODEX_BRIDGE_SCHEMA_VERSION,
    url,
    tokenFile,
  };

  try {
    writeFileSync(tokenFile, `${token}\n`, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    writeFileSync(bridgeFile, `${JSON.stringify(descriptor)}\n`, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    unlinkIfPresent(bridgeFile);
    unlinkIfPresent(tokenFile);
    throw error;
  }

  let cleaned = false;
  return {
    url,
    token,
    tokenFile,
    bridgeFile,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      unlinkIfPresent(bridgeFile);
      unlinkIfPresent(tokenFile);
      try {
        rmdirSync(runtimeDir);
      } catch {
        // Other hosted Codex sessions may still own files in this directory.
      }
    },
  };
}

export async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to reserve a localhost port for Codex App Server'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForAppServerReady(url: string, child: ChildProcess): Promise<void> {
  const readyUrl = `${url.replace(/^ws:/, 'http:')}/readyz`;
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Codex App Server exited before it became ready');
    }
    if (await probeReady(readyUrl)) return;
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for Codex App Server readiness');
    }
    await sleep(100);
  }
}

function probeReady(url: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const request = get(url, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(500, () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

async function waitForSpawn(child: ChildProcess, label: string): Promise<void> {
  if (child.pid !== undefined) return;
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (error) => reject(new Error(`${label} failed to start: ${error.message}`)));
  });
}

function waitForExit(child: ChildProcess): Promise<number> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  if (child.signalCode !== null) return Promise.resolve(1);
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      child.off('exit', onExit);
      reject(error);
    };
    const onExit = (code: number | null): void => {
      child.off('error', onError);
      resolve(code ?? 1);
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    sleep(SERVER_STOP_GRACE_MS),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
}

function captureOutputTail(child: ChildProcess, maxChars = 8_000): () => string {
  let output = '';
  const append = (chunk: unknown): void => {
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
    if (output.length > maxChars) output = output.slice(-maxChars);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return () => output;
}

function rejectOwnedRemoteFlags(args: readonly string[]): void {
  if (args.some((arg) => arg === '--remote' || arg.startsWith('--remote='))) {
    throw new Error('crew-mcp codex owns --remote; remove that argument');
  }
  if (args.some(
    (arg) => arg === '--remote-auth-token-env' || arg.startsWith('--remote-auth-token-env='),
  )) {
    throw new Error('crew-mcp codex owns --remote-auth-token-env; remove that argument');
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
