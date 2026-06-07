import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ResolveRepoRootOptions {
  readonly repoRoot?: string;
  readonly cwd?: string;
}

export async function resolveGitRepoRoot(
  options: ResolveRepoRootOptions = {},
): Promise<string> {
  if (options.repoRoot && options.repoRoot.trim().length > 0) {
    return options.repoRoot;
  }

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--show-toplevel'],
      {
        cwd: options.cwd ?? process.cwd(),
        timeout: 5_000,
      },
    );
    const root = stdout.trim();
    if (root.length > 0) return root;
  } catch {
    // Fall through to the user-facing install/verify guidance below.
  }

  throw new Error(
    'Project scope requires a Git worktree. Run from a repository checkout, '
    + 'or pass repoRoot in tests.',
  );
}
