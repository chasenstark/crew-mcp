import { accessSync, constants } from 'node:fs';
import { delimiter, posix, win32 } from 'node:path';

/**
 * Resolve the absolute crew binary the host CLI should spawn.
 *
 * In production, `crew-mcp install` is invoked from the same npm-installed
 * binary the host CLI will later spawn. We capture:
 *
 *   - process.execPath  — node interpreter (cross-platform safe)
 *   - process.argv[1]   — absolute path to dist/index.js (the script
 *                         node was invoked with; resolved through
 *                         npm's bin shim or symlink already)
 *
 * That pair is what we write into the host's MCP config. Users who
 * later move their npm prefix or reinstall will need to `crew-mcp install`
 * again — this is documented in the README.
 *
 * Tests inject `CrewBinaryResolver` to bypass argv resolution.
 */

export interface ResolvedCrewBinary {
  /** Absolute path to the executable to run (typically node). */
  readonly command: string;
  /** Args passed to that executable (script path + 'serve'). */
  readonly args: readonly string[];
}

export type CrewBinaryResolver = () => ResolvedCrewBinary;
export type ProjectCrewBinaryStrategy = 'node-modules-bin' | 'npx';

/**
 * Default resolver — used in production. argv[1] is the script path
 * node was invoked with; in npm-shim invocations that resolves to the
 * real dist/index.js inside the install location. Throws if argv[1]
 * is somehow missing (would indicate a broken Node invocation).
 */
export const defaultCrewBinaryResolver: CrewBinaryResolver = () => {
  const scriptPath = process.argv[1];
  if (!scriptPath || scriptPath.length === 0) {
    throw new Error(
      'Cannot resolve crew-mcp binary: process.argv[1] is empty. Are you running crew-mcp via an unusual launcher?',
    );
  }
  return {
    command: process.execPath,
    args: [scriptPath, 'serve'],
  };
};

export interface ProjectCrewBinaryResolverOptions {
  readonly repoRoot: string;
  readonly strategy?: ProjectCrewBinaryStrategy;
  readonly platform?: NodeJS.Platform;
}

export const projectCrewBinaryResolver = (
  options: ProjectCrewBinaryResolverOptions,
): ResolvedCrewBinary => {
  if (options.repoRoot.trim().length === 0) {
    throw new Error('Cannot resolve project crew-mcp binary: repoRoot is empty.');
  }
  const strategy = options.strategy ?? 'node-modules-bin';
  if (strategy === 'npx') {
    return {
      command: 'npx',
      args: ['--no-install', 'crew-mcp', 'serve'],
    };
  }
  return {
    command: options.platform === 'win32'
      ? '.\\node_modules\\.bin\\crew-mcp.cmd'
      : './node_modules/.bin/crew-mcp',
    args: ['serve'],
  };
};

export function projectCrewWaitCommand(options: {
  readonly strategy?: ProjectCrewBinaryStrategy;
  readonly platform?: NodeJS.Platform;
} = {}): string {
  const strategy = options.strategy ?? 'node-modules-bin';
  if (strategy === 'npx') {
    return 'npx --no-install crew-wait';
  }
  return options.platform === 'win32'
    ? '.\\node_modules\\.bin\\crew-wait.cmd'
    : './node_modules/.bin/crew-wait';
}

const TRUSTED_PROJECT_CREW_WAIT_COMMANDS = new Set([
  projectCrewWaitCommand({ platform: 'darwin' }),
  projectCrewWaitCommand({ platform: 'win32' }),
  projectCrewWaitCommand({ strategy: 'npx' }),
]);

/**
 * Project install manifests live in the repository and may therefore be
 * supplied by an untrusted checkout. Only commands emitted by Crew's own
 * project installer are safe to place in an auto-executed watcher envelope.
 */
export function isTrustedProjectCrewWaitCommand(command: string): boolean {
  return TRUSTED_PROJECT_CREW_WAIT_COMMANDS.has(command);
}

export function parseProjectCrewBinaryStrategy(raw: unknown): ProjectCrewBinaryStrategy {
  if (raw === undefined || raw === null || raw === '') return 'node-modules-bin';
  if (raw === 'node-modules-bin' || raw === 'npx') return raw;
  throw new Error(
    `Invalid --binary-strategy "${String(raw)}"; expected "node-modules-bin" or "npx".`,
  );
}

export interface ResolveCrewWaitBinaryOptions {
  readonly platform?: NodeJS.Platform;
  readonly pathEnv?: string;
  readonly access?: (candidate: string, mode: number) => void;
}

/**
 * Resolve the `crew-wait` executable for Claude Code Bash allowlisting.
 *
 * The direct PATH lookup is preferred because it lets us allowlist the
 * portable `crew-wait` command. If that fails, derive the sibling binary from
 * the installed `crew-mcp` shim so npm-linked and globally-installed layouts
 * still work.
 */
export function resolveCrewWaitBinary(options: ResolveCrewWaitBinaryOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const access = options.access ?? accessSync;

  const direct = firstExecutable(
    pathCandidates('crew-wait', { platform, pathEnv }),
    { platform, access },
  );
  if (direct) return direct;

  const crewMcp = firstExecutable(
    pathCandidates('crew-mcp', { platform, pathEnv }),
    { platform, access },
  );
  if (crewMcp) {
    const sibling = firstExecutable(
      siblingCrewWaitCandidates(crewMcp, platform),
      { platform, access },
    );
    if (sibling) return sibling;
  }

  throw new Error(
    'Cannot resolve crew-wait binary. Install crew-mcp globally with `npm install -g crew-mcp`, then re-run `crew-mcp install`.',
  );
}

export function isCrewWaitOnPath(options: ResolveCrewWaitBinaryOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const access = options.access ?? accessSync;
  return Boolean(
    firstExecutable(pathCandidates('crew-wait', { platform, pathEnv }), { platform, access }),
  );
}

/** Quote a resolved executable path for the host's default command shell. */
export function quoteExecutablePath(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    // Codex uses PowerShell on Windows. A quoted path alone is a string
    // expression there; `&` invokes it. Escape PowerShell interpolation
    // characters that are legal in Windows paths.
    const escaped = executablePath
      .replace(/`/g, '``')
      .replace(/\$/g, '`$');
    return `& "${escaped}"`;
  }
  return `'${executablePath.replace(/'/g, `'"'"'`)}'`;
}

function firstExecutable(
  candidates: readonly string[],
  args: {
    readonly platform: NodeJS.Platform;
    readonly access: (candidate: string, mode: number) => void;
  },
): string | undefined {
  for (const candidate of candidates) {
    try {
      args.access(candidate, args.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // Keep walking PATH / sibling candidates.
    }
  }
  return undefined;
}

function pathCandidates(
  command: string,
  args: {
    readonly platform: NodeJS.Platform;
    readonly pathEnv: string;
  },
): string[] {
  const pathApi = args.platform === 'win32' ? win32 : posix;
  const pathDelimiter = args.platform === 'win32' ? ';' : delimiter;
  const dirs = args.pathEnv
    .split(pathDelimiter)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const names = args.platform === 'win32'
    ? windowsCommandNames(command)
    : [command];
  const candidates: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      candidates.push(pathApi.join(dir, name));
    }
  }
  return candidates;
}

function siblingCrewWaitCandidates(crewMcpPath: string, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') {
    return [posix.join(posix.dirname(crewMcpPath), 'crew-wait')];
  }

  const dir = win32.dirname(crewMcpPath);
  const ext = win32.extname(crewMcpPath).toLowerCase();
  const extensions = ext.length > 0
    ? unique([ext, '.cmd', '.ps1', '.exe', '.bat', ''])
    : ['.cmd', '.ps1', '.exe', '.bat', ''];
  return extensions.map((candidateExt) => win32.join(dir, `crew-wait${candidateExt}`));
}

function windowsCommandNames(command: string): string[] {
  const ext = win32.extname(command);
  if (ext.length > 0) return [command];
  return ['.cmd', '.ps1', '.exe', '.bat', ''].map((candidateExt) => `${command}${candidateExt}`);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
