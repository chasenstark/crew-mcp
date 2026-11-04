import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, win32 } from 'node:path';
import type { RepositoryFileContext } from '../adapters/types.js';

export const CONTEXT_EGRESS_SKIPPED_WARNING =
  'context_egress_skipped: Repository files were not read or sent because this endpoint is remote. '
  + 'Set CREW_OPENAI_ALLOW_REMOTE_CONTEXT=1 to opt in, or use a loopback endpoint.';

export interface NamedFileContextCaps {
  readonly maxFileBytes: number;
  readonly maxContextBytes: number;
  readonly maxRequestTokens: number;
  readonly outputReserveTokens: number;
  readonly framingReserveTokens: number;
}

export const DEFAULT_NAMED_FILE_CONTEXT_CAPS: NamedFileContextCaps = {
  maxFileBytes: 32 * 1024,
  maxContextBytes: 64 * 1024,
  maxRequestTokens: 16_384,
  outputReserveTokens: 4096,
  framingReserveTokens: 1024,
};

type FileEntry = RepositoryFileContext['files'][number];
type Omission = RepositoryFileContext['omissions'][number];
interface PathSnapshot { readonly path: string; readonly stat: Stats }

/**
 * The token estimate is deliberately conservative for ordinary source text,
 * not a tokenizer or a guarantee about a backend's actual context window.
 * Raw byte limits independently bound reads; JSON framing is charged too.
 */
function estimatedTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

function resolveCaps(overrides: Partial<NamedFileContextCaps> | undefined): NamedFileContextCaps {
  const caps = { ...DEFAULT_NAMED_FILE_CONTEXT_CAPS, ...overrides };
  for (const [key, value] of Object.entries(caps)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid repository context cap: ${key}`);
    }
  }
  return caps;
}

function pathReason(path: string): string | undefined {
  if (!path || path.length > 4096 || path.includes('\0') || path.includes('\\')) return 'invalid_path';
  if (isAbsolute(path) || win32.isAbsolute(path) || /^[a-z]:/i.test(path)) return 'absolute_path';
  const parts = path.split('/');
  if (parts.includes('..')) return 'path_traversal';
  if (parts.some((part) => part.toLowerCase() === '.git')) return 'git_metadata';
  if (parts.every((part) => part === '' || part === '.')) return 'not_regular_file';
  return undefined;
}

function normalizedPath(path: string): string {
  return path.split('/').filter((part) => part !== '' && part !== '.').join('/');
}

function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameFile(a: Stats, b: Stats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function errorReason(error: unknown): string {
  switch ((error as NodeJS.ErrnoException)?.code) {
    case 'ENOENT': return 'missing';
    case 'ELOOP': return 'symlink';
    case 'ENOTDIR': return 'not_regular_file';
    default: return 'unreadable';
  }
}

async function parentsUnchanged(parents: readonly PathSnapshot[], signal?: AbortSignal): Promise<boolean> {
  for (const parent of parents) {
    signal?.throwIfAborted();
    const current = await lstat(parent.path);
    if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(parent.stat, current)) return false;
  }
  return true;
}

async function readNamedFile(
  root: string,
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ content: string; bytes: number } | { reason: string }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    signal?.throwIfAborted();
    const parts = path.split('/');
    const parents: PathSnapshot[] = [];
    let directory = root;
    for (let index = 0; index < parts.length; index += 1) {
      signal?.throwIfAborted();
      const current = await lstat(directory);
      if (current.isSymbolicLink()) return { reason: 'symlink' };
      if (!current.isDirectory()) return { reason: 'not_regular_file' };
      parents.push({ path: directory, stat: current });
      if (index < parts.length - 1) directory = join(directory, parts[index]);
    }
    const absolute = join(root, ...parts);
    const before = await lstat(absolute);
    if (before.isSymbolicLink()) return { reason: 'symlink' };
    if (!before.isFile()) return { reason: 'not_regular_file' };
    if (before.size > maxBytes) return { reason: 'too_large' };
    signal?.throwIfAborted();
    // O_NONBLOCK prevents a raced-in FIFO/device from blocking open. O_NOFOLLOW
    // protects the final component; parent identity checks cover ordinary swaps.
    // Portable Node has no openat chain: this is not an OS sandbox against an
    // attacker concurrently replacing and restoring ancestor directories.
    if (!constants.O_NOFOLLOW) return { reason: 'unsupported_platform' };
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened) || !await parentsUnchanged(parents, signal)) {
      return { reason: 'file_changed' };
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes <= maxBytes) {
      signal?.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(8192, maxBytes + 1 - bytes));
      const read = await handle.read(buffer, 0, buffer.length, bytes);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > maxBytes) return { reason: 'too_large' };
      chunks.push(buffer.subarray(0, read.bytesRead));
    }
    signal?.throwIfAborted();
    const after = await handle.stat();
    const atPath = await lstat(absolute);
    if (!sameFile(opened, after) || !sameFile(after, atPath) || atPath.isSymbolicLink()
      || bytes !== after.size || !await parentsUnchanged(parents, signal)) {
      return { reason: 'file_changed' };
    }
    const contents = Buffer.concat(chunks, bytes);
    // NUL and non-text control characters are conservative binary indicators.
    if (contents.some((byte) => byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13))) {
      return { reason: 'binary' };
    }
    try {
      return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(contents), bytes };
    } catch {
      return { reason: 'invalid_utf8' };
    }
  } catch (error) {
    signal?.throwIfAborted();
    return { reason: errorReason(error) };
  } finally {
    await handle?.close();
  }
}

/** Assemble only explicitly requested files; never infer or collect a diff. */
export async function assembleNamedFileContext(input: {
  readonly workingDirectory: string;
  readonly contextFiles: readonly string[];
  readonly prompt: string;
  readonly allowRead: boolean;
  readonly signal?: AbortSignal;
  readonly caps?: Partial<NamedFileContextCaps>;
}): Promise<{ context: RepositoryFileContext; warnings: string[] }> {
  input.signal?.throwIfAborted();
  const caps = resolveCaps(input.caps);
  if (input.contextFiles.length > 50) throw new Error('Repository context accepts at most 50 files');
  const requested = [...new Map(input.contextFiles.map((path) => {
    const reason = pathReason(path);
    const normalized = reason ? path : normalizedPath(path);
    return [normalized, { path: normalized, reason }] as const;
  })).values()];
  const files: FileEntry[] = [];
  const omissions: Omission[] = [];
  const warnings = input.allowRead || requested.length === 0 ? [] : [CONTEXT_EGRESS_SKIPPED_WARNING];
  const tokenBudget = caps.maxRequestTokens - caps.outputReserveTokens - caps.framingReserveTokens
    - estimatedTokens(input.prompt);
  const fits = (candidateFiles: readonly FileEntry[], candidateOmissions: readonly Omission[]) =>
    estimatedTokens(JSON.stringify({ files: candidateFiles, omissions: candidateOmissions })) <= tokenBudget;
  if (requested.length === 0) return { context: { files, omissions }, warnings };
  // Reserve every path's framing before any reads, so later omissions cannot
  // silently push an already-selected file over the request budget.
  const pending = requested.map(({ path }) => ({ path, reason: 'context_metadata_budget_exhausted' }));
  if (!fits([], pending)) {
    // Keep one disclosure even if the existing task already exhausts the
    // estimate. This budget limits added file data, not the caller's prompt;
    // the small omission marker must not silently disappear with the files.
    return {
      context: { files: [], omissions: [{ path: '*', reason: 'metadata_budget_exhausted' }] },
      warnings: [...warnings, `context_truncated: Metadata for ${requested.length} requested files exceeds the estimated request budget; no file content was read. Backend context visibility is not verifiable.`],
    };
  }
  if (!input.allowRead) {
    return {
      context: { files, omissions: requested.map(({ path }) => ({ path, reason: 'remote_context_disabled' })) },
      warnings,
    };
  }
  let root: string | undefined;
  let rootError: string | undefined;
  try {
    root = await realpath(input.workingDirectory);
    if (root.split(/[\\/]/).some((part) => part.toLowerCase() === '.git')) rootError = 'git_metadata';
  } catch (error) {
    input.signal?.throwIfAborted();
    rootError = errorReason(error);
  }
  let rawBytes = 0;
  for (let index = 0; index < requested.length; index += 1) {
    input.signal?.throwIfAborted();
    const request = requested[index];
    let reason = request.reason ?? rootError;
    if (!reason && rawBytes >= caps.maxContextBytes) reason = 'budget_exhausted';
    if (!reason && root !== undefined) {
      const result = await readNamedFile(root, request.path, caps.maxFileBytes, input.signal);
      if ('reason' in result) {
        reason = result.reason;
      } else {
        const file = { path: request.path, content: result.content };
        if (rawBytes + result.bytes > caps.maxContextBytes
          || !fits([...files, file], [...omissions, ...pending.slice(index + 1)])) {
          reason = 'budget_exhausted';
        } else {
          files.push(file);
          rawBytes += result.bytes;
        }
      }
    }
    if (reason) omissions.push({ path: request.path, reason });
  }
  const truncated = omissions.filter(({ reason }) => reason === 'too_large' || reason === 'budget_exhausted');
  if (truncated.length > 0) {
    warnings.push(`context_truncated: ${truncated.length} requested files were omitted by Crew's file or estimated request budget. Backend context visibility is not verifiable.`);
  }
  const other = omissions.length - truncated.length;
  if (other > 0) warnings.push(`context_file_omitted: ${other} requested files could not be included; see the repository context omission reasons.`);
  return { context: { files, omissions }, warnings };
}
