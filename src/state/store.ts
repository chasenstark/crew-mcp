import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import type { WorkflowState, PassSummary, Message } from './types.js';
import { atomicWrite } from '../utils/atomic-write.js';

export class StateStore {
  private basePath: string;

  constructor(projectRoot: string) {
    this.basePath = join(projectRoot, '.orchestra');
    mkdirSync(join(this.basePath, 'passes'), { recursive: true });
    mkdirSync(join(this.basePath, 'summaries'), { recursive: true });
    mkdirSync(join(this.basePath, 'runs'), { recursive: true });
  }

  saveState(state: WorkflowState): void {
    atomicWrite(
      join(this.basePath, 'state.json'),
      JSON.stringify(state, null, 2),
    );
  }

  loadState(): WorkflowState | null {
    const path = join(this.basePath, 'state.json');
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return null;
    }
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

  saveConversation(messages: Message[]): void {
    atomicWrite(
      join(this.basePath, 'conversation.json'),
      JSON.stringify(messages, null, 2),
    );
  }

  loadConversation(): Message[] {
    const path = join(this.basePath, 'conversation.json');
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return [];
    }
  }

  clear(): void {
    for (const sub of ['state.json', 'conversation.json', 'passes', 'summaries', 'runs']) {
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
