import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'fs';
import { join } from 'path';
import type { WorkflowState, PassSummary } from './types.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { migrateStateToV4 } from './migrations/v3-to-v4.js';
import {
  CURRENT_STATE_SCHEMA_VERSION,
  migrateStateToV5,
  LegacyExecutionModeError,
} from './migrations/v4-to-v5.js';
import { logger } from '../utils/logger.js';

export { LegacyExecutionModeError };

export class StateStore {
  private basePath: string;
  private legacyConversationHandled = false;

  constructor(projectRoot: string) {
    this.basePath = join(projectRoot, '.crew');
    mkdirSync(join(this.basePath, 'passes'), { recursive: true });
    mkdirSync(join(this.basePath, 'summaries'), { recursive: true });
    mkdirSync(join(this.basePath, 'runs'), { recursive: true });
    this.renameLegacyConversationFile();
  }

  saveState(state: WorkflowState): void {
    const versioned: WorkflowState = {
      ...state,
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    };
    atomicWrite(
      join(this.basePath, 'state.json'),
      JSON.stringify(versioned, null, 2),
    );
  }

  loadState(): WorkflowState | null {
    const path = join(this.basePath, 'state.json');
    if (!existsSync(path)) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return null;
    }
    // Chain v3→v4→v5. migrateStateToV4 tags v3/unversioned as v4; v5 drops
    // the nine runtime-scratch fields and rejects legacy linear mode.
    const v4 = migrateStateToV4(raw);
    if (v4 === null) return null;
    return migrateStateToV5(v4);
  }

  private renameLegacyConversationFile(): void {
    if (this.legacyConversationHandled) return;
    const legacyPath = join(this.basePath, 'conversation.json');
    if (!existsSync(legacyPath)) {
      this.legacyConversationHandled = true;
      return;
    }
    const renamedPath = join(this.basePath, 'conversation.legacy.json');
    try {
      renameSync(legacyPath, renamedPath);
      logger.warn(
        `[state] legacy .crew/conversation.json found; renamed to conversation.legacy.json. ` +
          'The conversation persistence layer was removed; this file is no longer read.',
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[state] failed to rename legacy conversation.json: ${message}`);
    }
    this.legacyConversationHandled = true;
  }

  hasInterruptedWorkflow(): boolean {
    const state = this.loadState();
    return state !== null && (state.status === 'running' || state.status === 'interrupted');
  }

  private resolveRunId(runId?: string): string | undefined {
    if (runId) return runId;
    const state = this.loadState();
    return state?.runId;
  }

  private getRunPath(runId: string): string {
    return join(this.basePath, 'runs', runId);
  }

  private ensureRunDirs(runId: string): void {
    const runPath = this.getRunPath(runId);
    mkdirSync(join(runPath, 'passes'), { recursive: true });
    mkdirSync(join(runPath, 'summaries'), { recursive: true });
  }

  addPassSummary(summary: PassSummary, runId?: string): void {
    const resolvedRunId = this.resolveRunId(runId);
    if (resolvedRunId) {
      this.ensureRunDirs(resolvedRunId);
      atomicWrite(
        join(
          this.getRunPath(resolvedRunId),
          'summaries',
          `pass-${String(summary.passNumber).padStart(3, '0')}.json`,
        ),
        JSON.stringify(summary, null, 2),
      );
      return;
    }

    atomicWrite(
      join(this.basePath, 'summaries', `pass-${String(summary.passNumber).padStart(3, '0')}.json`),
      JSON.stringify(summary, null, 2),
    );
  }

  loadPassSummaries(runId?: string): PassSummary[] {
    const resolvedRunId = this.resolveRunId(runId);
    const dir = resolvedRunId
      ? join(this.getRunPath(resolvedRunId), 'summaries')
      : join(this.basePath, 'summaries');
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((f: string) => f.endsWith('.json'))
        .sort()
        .map((f: string) => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
    } catch {
      return [];
    }
  }

  addPassOutput(passNumber: number, output: unknown, runId?: string): void {
    const resolvedRunId = this.resolveRunId(runId);
    if (resolvedRunId) {
      this.ensureRunDirs(resolvedRunId);
      atomicWrite(
        join(
          this.getRunPath(resolvedRunId),
          'passes',
          `pass-${String(passNumber).padStart(3, '0')}.json`,
        ),
        JSON.stringify(output, null, 2),
      );
      return;
    }

    atomicWrite(
      join(this.basePath, 'passes', `pass-${String(passNumber).padStart(3, '0')}.json`),
      JSON.stringify(output, null, 2),
    );
  }

  clear(): void {
    for (const sub of ['state.json', 'passes', 'summaries', 'runs']) {
      const path = join(this.basePath, sub);
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
    }
    mkdirSync(join(this.basePath, 'passes'), { recursive: true });
    mkdirSync(join(this.basePath, 'summaries'), { recursive: true });
    mkdirSync(join(this.basePath, 'runs'), { recursive: true });
  }
}
