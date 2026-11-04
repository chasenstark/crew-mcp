import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { RepositoryFileContext, RepositoryReviewSource } from '../adapters/types.js';

type Diff = NonNullable<RepositoryFileContext['diff']>;
type DiffFile = Diff['files'][number];
type Omission = Diff['omissions'][number];
interface TreeEntry { mode: string; oid: string; size: number }
interface IndexEntry { mode: string; sparse: boolean; conflict: boolean }
type ReadResult = { content: string; bytes: number; mode: number; bytesRead: number }
  | { reason: string; bytesRead: number };

export interface AutomaticDiffCaps {
  readonly maxMetadataBytes: number;
  readonly maxPaths: number;
  readonly maxScanBytes: number;
  readonly timeoutMs: number;
}

export const DEFAULT_AUTOMATIC_DIFF_CAPS: AutomaticDiffCaps = {
  maxMetadataBytes: 512 * 1024,
  maxPaths: 2000,
  maxScanBytes: 2 * 1024 * 1024,
  timeoutMs: 5000,
};

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REGULAR_MODES = new Set(['100644', '100755']);
const INCOMPLETE_WARNING = 'context_diff_incomplete: Automatic repository changes are incomplete; inspect the attached omission reasons and do not treat this as a complete checkout review.';
const TRUNCATED_WARNING = 'context_truncated: Whole automatic file patches were omitted by the file, scan, or estimated request budget. Backend context visibility is not verifiable.';
const REMOTE_WARNING = 'context_egress_skipped: Repository context was not read or sent because this endpoint is remote. Set CREW_OPENAI_ALLOW_REMOTE_CONTEXT=1 to opt in, or use a loopback endpoint.';

class CaptureError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  // Keep normal global ignores, but no inherited Git repository/config/trace,
  // pager, askpass, or dynamic-loader overrides. No remote protocol is allowed.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0',
    GIT_LITERAL_PATHSPECS: '1',
  };
}

/** A single cumulative deadline/output budget, and no shell or worktree diff. */
export class ContextGitReader {
  private readonly deadline: number;
  private metadataBytes = 0;

  constructor(
    private readonly cwd: string,
    private readonly caps: AutomaticDiffCaps,
    private readonly signal?: AbortSignal,
  ) {
    this.deadline = Date.now() + caps.timeoutMs;
  }

  check(): void {
    this.signal?.throwIfAborted();
    if (Date.now() >= this.deadline) throw new CaptureError('scan_timeout');
  }

  async run(args: readonly string[], options: { maxBytes?: number; metadata?: boolean } = {}): Promise<Buffer> {
    this.check();
    const metadata = options.metadata !== false;
    const limit = Math.min(options.maxBytes ?? this.caps.maxMetadataBytes,
      metadata ? this.caps.maxMetadataBytes - this.metadataBytes : Infinity);
    if (limit <= 0) throw new CaptureError('metadata_budget_exhausted');
    const prefix = [
      '--no-pager', '--no-optional-locks', '--no-replace-objects', '--literal-pathspecs',
      '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
      '-c', 'submodule.recurse=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
    ];
    const output = await new Promise<Buffer>((fulfill, reject) => {
      const child = spawn('git', [...prefix, ...args], {
        cwd: this.cwd, env: gitEnvironment(), shell: false,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stderrBytes = 0;
      let failure: unknown;
      const kill = (error: unknown): void => {
        if (failure !== undefined) return;
        failure = error;
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          try { child.kill('SIGKILL'); } catch { /* Already gone; still await close. */ }
        }
      };
      const onAbort = () => kill(this.signal?.reason ?? new CaptureError('cancelled'));
      const timer = setTimeout(() => kill(new CaptureError('scan_timeout')), Math.max(1, this.deadline - Date.now()));
      timer.unref?.();
      this.signal?.addEventListener('abort', onAbort, { once: true });
      if (this.signal?.aborted) onAbort();
      child.stdout.on('data', (chunk: Buffer) => {
        if (failure !== undefined) return;
        bytes += chunk.length;
        if (bytes > limit) kill(new CaptureError(metadata ? 'metadata_budget_exhausted' : 'blob_too_large'));
        else chunks.push(chunk);
      });
      // Retain no stderr text: Git errors can contain paths/config/provider data.
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 4096) kill(new CaptureError('git_error'));
      });
      child.once('error', () => { failure ??= new CaptureError('git_unavailable'); });
      child.once('close', (code) => {
        clearTimeout(timer);
        this.signal?.removeEventListener('abort', onAbort);
        if (failure !== undefined) reject(failure);
        else if (code !== 0) reject(new CaptureError('git_error'));
        else fulfill(Buffer.concat(chunks, bytes));
      });
    });
    if (metadata) this.metadataBytes += output.length;
    this.check();
    return output;
  }
}

function decode(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new CaptureError('invalid_utf8'); }
}

function records(bytes: Buffer): string[] {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) throw new CaptureError('malformed_metadata');
  return decode(bytes.subarray(0, -1)).split('\0');
}

function treeEntries(bytes: Buffer): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (const record of records(bytes)) {
    const match = /^([0-7]{6}) (?:blob|commit|tree) ([a-f0-9]+) +(-|[0-9]+)\t([\s\S]+)$/.exec(record);
    if (!match || !OID.test(match[2]) || entries.has(match[4])) throw new CaptureError('malformed_metadata');
    const size = match[3] === '-' ? 0 : Number(match[3]);
    if (!Number.isSafeInteger(size)) throw new CaptureError('malformed_metadata');
    entries.set(match[4], { mode: match[1], oid: match[2], size });
  }
  return entries;
}

function indexEntries(bytes: Buffer): Map<string, IndexEntry> {
  const entries = new Map<string, IndexEntry>();
  for (const record of records(bytes)) {
    const match = /^([A-Za-z?]) ([0-7]{6}) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match || !OID.test(match[3])) throw new CaptureError('malformed_metadata');
    const previous = entries.get(match[5]);
    entries.set(match[5], {
      mode: match[2], sparse: match[1].toUpperCase() === 'S',
      conflict: match[4] !== '0' || previous !== undefined,
    });
  }
  return entries;
}

function blobHash(content: string, bytes: number, oid: string): string {
  return createHash(oid.length === 64 ? 'sha256' : 'sha1')
    .update(`blob ${bytes}\0`).update(content, 'utf8').digest('hex');
}

function textBlob(bytes: Buffer): string {
  if (bytes.some((byte) => byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13))) {
    throw new CaptureError('binary');
  }
  return decode(bytes);
}

function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Linear, single-span unified patch. Sparse edits may exceed the whole-file cap. */
export function conservativePatch(path: string, before: string, after: string, oldMode?: string, newMode?: string): string {
  const oldLines = lines(before);
  const newLines = lines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
  const label = JSON.stringify(path);
  const mode = oldMode !== newMode ? `mode ${oldMode ?? 'absent'} -> ${newMode ?? 'absent'}\n` : '';
  if (prefix === oldLines.length && prefix === newLines.length) return mode ? `file ${label}\n${mode}` : '';
  const start = Math.max(0, prefix - 3);
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3);
  const newEnd = Math.min(newLines.length, newLines.length - suffix + 3);
  const emit = (sign: string, line: string) => `${sign}${line}${line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n'}`;
  const range = (begin: number, count: number) => `${count === 0 ? begin : begin + 1},${count}`;
  let patch = `file ${label}\n${mode}--- ${oldMode ? label : '/dev/null'}\n+++ ${newMode ? label : '/dev/null'}\n`
    + `@@ -${range(start, oldEnd - start)} +${range(start, newEnd - start)} @@\n`;
  for (let i = start; i < prefix; i += 1) patch += emit(' ', oldLines[i]);
  for (let i = prefix; i < oldLines.length - suffix; i += 1) patch += emit('-', oldLines[i]);
  for (let i = prefix; i < newLines.length - suffix; i += 1) patch += emit('+', newLines[i]);
  for (let i = oldLines.length - suffix; i < oldEnd; i += 1) patch += emit(' ', oldLines[i]);
  return patch;
}

export async function collectAutomaticDiff(input: {
  readonly workingDirectory: string;
  readonly reviewSource: RepositoryReviewSource;
  readonly allowRead: boolean;
  readonly signal?: AbortSignal;
  readonly caps?: Partial<AutomaticDiffCaps>;
  readonly maxFileBytes: number;
  readonly maxPatchBytes: number;
  readonly fits: (diff: Diff) => boolean;
  readonly pathReason: (path: string) => string | undefined;
  readonly readFile: (root: string, path: string, maxBytes: number, signal?: AbortSignal) => Promise<ReadResult>;
}): Promise<{ diff: Diff; warnings: string[] }> {
  input.signal?.throwIfAborted();
  const caps = { ...DEFAULT_AUTOMATIC_DIFF_CAPS, ...input.caps };
  for (const [key, value] of Object.entries(caps)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid automatic diff cap: ${key}`);
  }
  const files: DiffFile[] = [];
  const omissions: Omission[] = [];
  let baseCommit: string | undefined;
  let complete = true;
  let truncated = false;
  let metadataCollapsed = false;
  const source = input.reviewSource.kind === 'head' ? 'host-head'
    : input.reviewSource.kind === 'run' ? 'run-branch-point' : 'unavailable';
  const result = (): Diff => ({ ...(baseCommit ? { baseCommit } : {}), source, files, omissions, complete });
  const omit = (path: string, reason: string): void => {
    complete = false;
    truncated ||= /budget|too_large|path_limit/.test(reason);
    if (metadataCollapsed) return;
    const next = { path: path.length > 4096 ? '*' : path, reason };
    if (input.fits({ ...result(), omissions: [...omissions, next] })) omissions.push(next);
    else {
      metadataCollapsed = true;
      omissions.splice(0, omissions.length, { path: '*', reason: 'metadata_budget_exhausted' });
      truncated = true;
    }
  };
  const finish = () => ({
    diff: result(),
    warnings: [
      ...(!input.allowRead ? [REMOTE_WARNING] : []),
      ...(!complete ? [INCOMPLETE_WARNING] : []),
      ...(truncated ? [TRUNCATED_WARNING] : []),
    ],
  });
  if (!input.allowRead) { omit('*', 'remote_context_disabled'); return finish(); }
  if (input.reviewSource.kind === 'unavailable') { omit('*', 'baseline_unavailable'); return finish(); }
  if (!input.fits({ ...result(), baseCommit: 'f'.repeat(64), complete: false,
    omissions: [{ path: '*', reason: 'metadata_budget_exhausted' }] })) {
    omit('*', 'budget_exhausted'); return finish();
  }
  try {
    const root = await realpath(input.workingDirectory);
    input.signal?.throwIfAborted();
    if (root.split(/[\\/]/).some((part) => part.toLowerCase() === '.git')) {
      omit('*', 'git_metadata'); return finish();
    }
    const git = new ContextGitReader(root, caps, input.signal);
    const top = decode(await git.run(['rev-parse', '--show-toplevel'])).trimEnd();
    if (await realpath(top) !== root) { omit('*', 'not_repository_root'); return finish(); }
    const head = decode(await git.run(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    if (!OID.test(head)) throw new CaptureError('baseline_unavailable');
    const candidateBase = input.reviewSource.kind === 'run' ? input.reviewSource.baseCommit : head;
    if (!OID.test(candidateBase)) throw new CaptureError('baseline_unavailable');
    baseCommit = candidateBase;
    if (decode(await git.run(['cat-file', '-t', baseCommit])).trim() !== 'commit') throw new CaptureError('baseline_unavailable');
    const base = treeEntries(await git.run(['ls-tree', '-r', '-z', '-l', '--full-tree', baseCommit]));
    const indexed = indexEntries(await git.run(['ls-files', '--cached', '--stage', '-v', '-z', '--full-name']));
    const untracked = records(await git.run(['ls-files', '--others', '--exclude-standard', '-z', '--full-name']));
    const candidates = [...new Set([...base.keys(), ...indexed.keys(), ...untracked])].sort();
    if (candidates.length > caps.maxPaths) omit('*', 'path_limit');
    let scanBytes = 0;
    let patchBytes = 0;
    for (const path of candidates.slice(0, caps.maxPaths)) {
      git.check();
      const invalid = input.pathReason(path);
      if (invalid) { omit(path, invalid); continue; }
      const old = base.get(path);
      const index = indexed.get(path);
      if (index?.conflict) { omit(path, 'unmerged'); continue; }
      if (index?.sparse) { omit(path, 'sparse_checkout'); continue; }
      if ((old && !REGULAR_MODES.has(old.mode)) || (index && !REGULAR_MODES.has(index.mode))) {
        omit(path, old?.mode === '160000' || index?.mode === '160000' ? 'submodule' : 'symlink');
        continue;
      }
      const remaining = caps.maxScanBytes - scanBytes;
      if (remaining <= 0) { omit('*', 'scan_budget_exhausted'); break; }
      const current = await input.readFile(root, path, Math.min(input.maxFileBytes, remaining - 1), input.signal);
      scanBytes += current.bytesRead;
      git.check();
      const missing = 'reason' in current && current.reason === 'missing';
      if ('reason' in current && !missing) {
        if (current.reason === 'too_large' && remaining <= input.maxFileBytes) {
          omit('*', 'scan_budget_exhausted'); break;
        }
        omit(path, current.reason); continue;
      }
      if (missing && !old) { omit(path, 'file_changed'); continue; }
      const content = 'content' in current ? current.content : '';
      const newMode = 'mode' in current ? ((current.mode & 0o100) !== 0 ? '100755' : '100644') : undefined;
      if (old && 'content' in current && blobHash(content, current.bytes, old.oid) === old.oid) {
        if (old.mode === newMode) continue;
      }
      let previous = '';
      if (old) {
        if (old.size > input.maxFileBytes) { omit(path, 'too_large'); continue; }
        if (scanBytes + old.size > caps.maxScanBytes) { omit('*', 'scan_budget_exhausted'); break; }
        try {
          const raw = await git.run(['cat-file', 'blob', old.oid], { maxBytes: Math.max(1, old.size), metadata: false });
          scanBytes += raw.length;
          if (raw.length !== old.size) throw new CaptureError('file_changed');
          previous = textBlob(raw);
        } catch (error) {
          input.signal?.throwIfAborted();
          if (error instanceof CaptureError && ['binary', 'invalid_utf8', 'blob_too_large'].includes(error.reason)) {
            omit(path, error.reason); continue;
          }
          throw error;
        }
      }
      const status: DiffFile['status'] = !old ? 'added' : missing ? 'deleted' : previous === content ? 'mode_changed' : 'modified';
      const patch = conservativePatch(path, previous, content, old?.mode, newMode);
      if (!patch) continue;
      const bytes = Buffer.byteLength(patch);
      if (bytes > input.maxFileBytes) { omit(path, 'patch_too_large'); continue; }
      const entry = { path, status, patch };
      // Reserve a bounded final omission marker before accepting another file.
      const reserve = metadataCollapsed ? omissions : [...omissions, { path: '*', reason: 'metadata_budget_exhausted' }];
      if (patchBytes + bytes > input.maxPatchBytes || !input.fits({ ...result(), files: [...files, entry], omissions: reserve })) {
        omit(path, 'budget_exhausted'); continue;
      }
      files.push(entry);
      patchBytes += bytes;
    }
  } catch (error) {
    input.signal?.throwIfAborted();
    omit('*', error instanceof CaptureError ? error.reason : 'repository_unavailable');
  }
  return finish();
}
