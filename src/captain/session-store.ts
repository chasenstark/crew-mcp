// SessionStore owns the on-disk representation of a captain session:
//
//   .crew/captain/session.json  — the snapshot (atomic write via tmp+rename)
//   .crew/captain/events.log    — NDJSON append-only event log (fsync per write)
//   .crew/captain/.lock         — advisory pid file for concurrent-writer detection
//
// Contention policy (intentional, not incidental):
//   - First writer acquires the lock, others log ONE warn and proceed.
//   - session.json: last-write-wins under contention. The snapshot is
//     idempotent enough that a late-write only loses the loser's in-flight
//     edits; the event log and message history are durable regardless.
//   - events.log: appends of a single event under 4 KB are atomic at the OS
//     level, so concurrent appendEvent calls are safe without the lock.
//     Larger events (e.g. big tool outputs) can interleave; the store truncates
//     output fields before persistence to keep events under the safe threshold.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { dirname, join } from 'path';
import type { SessionEvent } from './event-types.js';
import type { SessionMessage } from '../state/types.js';
import { logger } from '../utils/logger.js';

export interface SessionSnapshot {
  schemaVersion: 1;
  messages: SessionMessage[];
  providerSessionRef?: string;
  cliVersionTag?: string;
  toolSchemaHash?: string;
  startedAt: string;
  lastTurnAt?: string;
}

const CURRENT_SESSION_SCHEMA_VERSION = 1;

const MAX_EVENT_OUTPUT_BYTES = 3 * 1024;

function serializeEvent(event: SessionEvent): string {
  const payload: SessionEvent = truncateEventPayload(event);
  return `${JSON.stringify(payload)}\n`;
}

function truncateEventPayload(event: SessionEvent): SessionEvent {
  if (event.kind === 'tool_completed') {
    const serialized = JSON.stringify(event.result ?? null);
    if (serialized.length > MAX_EVENT_OUTPUT_BYTES) {
      return {
        ...event,
        result: {
          truncated: true,
          preview: serialized.slice(0, MAX_EVENT_OUTPUT_BYTES),
          originalBytes: serialized.length,
        },
      };
    }
  }
  if (event.kind === 'tool_failed' && event.error.length > MAX_EVENT_OUTPUT_BYTES) {
    return {
      ...event,
      error: `${event.error.slice(0, MAX_EVENT_OUTPUT_BYTES)}...[truncated]`,
    };
  }
  return event;
}

export class SessionStore {
  private readonly baseDir: string;
  private readonly sessionPath: string;
  private readonly eventsPath: string;
  private readonly lockPath: string;
  private lockWarnedOnce = false;
  private hasLock = false;

  constructor(projectRoot: string) {
    this.baseDir = join(projectRoot, '.crew', 'captain');
    this.sessionPath = join(this.baseDir, 'session.json');
    this.eventsPath = join(this.baseDir, 'events.log');
    this.lockPath = join(this.baseDir, '.lock');
  }

  loadSession(): SessionSnapshot | null {
    if (!existsSync(this.sessionPath)) return null;
    let raw: string;
    try {
      raw = readFileSync(this.sessionPath, 'utf-8');
    } catch (err: unknown) {
      logger.warn('[session-store] failed to read session.json', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!raw.trim()) {
      logger.warn('[session-store] session.json empty; treating as missing (likely partial write)');
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err: unknown) {
      logger.warn('[session-store] session.json invalid JSON; treating as missing', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!isValidSnapshot(parsed)) {
      logger.warn('[session-store] session.json shape unrecognized; treating as missing');
      return null;
    }
    return parsed;
  }

  writeSession(snapshot: SessionSnapshot): void {
    this.ensureDirs();
    this.acquireLockIfFree();
    const versioned: SessionSnapshot = {
      ...snapshot,
      schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    };
    atomicWrite(this.sessionPath, JSON.stringify(versioned, null, 2));
  }

  appendEvent(event: SessionEvent): void {
    this.ensureDirs();
    this.acquireLockIfFree();
    const line = serializeEvent(event);
    const fd = openSync(this.eventsPath, 'a');
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  readAllEvents(): SessionEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    const raw = readFileSync(this.eventsPath, 'utf-8');
    if (!raw) return [];
    const events: SessionEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (isValidEvent(parsed)) {
          events.push(parsed);
        }
      } catch {
        // Skip malformed lines without aborting the whole read; an interrupted
        // write leaves a partial line that we silently discard on reload.
      }
    }
    return events;
  }

  clear(): void {
    try {
      if (existsSync(this.sessionPath)) unlinkSync(this.sessionPath);
      if (existsSync(this.eventsPath)) unlinkSync(this.eventsPath);
      this.releaseLock();
    } catch (err: unknown) {
      logger.warn('[session-store] clear() encountered error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  releaseLock(): void {
    if (!this.hasLock) return;
    try {
      if (existsSync(this.lockPath)) {
        const content = readFileSync(this.lockPath, 'utf-8').trim();
        if (Number(content) === process.pid) {
          unlinkSync(this.lockPath);
        }
      }
    } catch {
      // best-effort cleanup
    }
    this.hasLock = false;
  }

  private ensureDirs(): void {
    mkdirSync(this.baseDir, { recursive: true });
  }

  private acquireLockIfFree(): void {
    if (this.hasLock) return;
    try {
      const fd = openSync(this.lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      this.hasLock = true;
      return;
    } catch (err: unknown) {
      // Lock held — check if by another live process. Warn once and proceed.
      if (!this.lockWarnedOnce) {
        const holder = this.readHolderPid();
        logger.warn(
          `[session-store] session lock held by another process (pid ${holder ?? 'unknown'}); proceeding with last-write-wins semantics on session.json`,
          { error: err instanceof Error ? err.message : String(err) },
        );
        this.lockWarnedOnce = true;
      }
    }
  }

  private readHolderPid(): number | null {
    try {
      const raw = readFileSync(this.lockPath, 'utf-8').trim();
      const pid = Number(raw);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }
}

function atomicWrite(filePath: string, data: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tempPath, data, 'utf-8');
  renameSync(tempPath, filePath);
}

function isValidSnapshot(value: unknown): value is SessionSnapshot {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== CURRENT_SESSION_SCHEMA_VERSION) return false;
  if (!Array.isArray(v.messages)) return false;
  if (typeof v.startedAt !== 'string') return false;
  return true;
}

function isValidEvent(value: unknown): value is SessionEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.kind !== 'string') return false;
  if (typeof v.ts !== 'string') return false;
  switch (v.kind) {
    case 'user_message':
      return typeof v.text === 'string';
    case 'tool_completed':
      return typeof v.toolCallId === 'string';
    case 'tool_failed':
      return typeof v.toolCallId === 'string' && typeof v.error === 'string';
    case 'tool_cancelled':
      return typeof v.toolCallId === 'string' && typeof v.reason === 'string';
    default:
      return false;
  }
}
