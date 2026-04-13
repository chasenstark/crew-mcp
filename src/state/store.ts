import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync } from 'fs';
import { join } from 'path';
import type { WorkflowState, PassSummary, Message } from './types.js';

export class StateStore {
  private basePath: string;

  constructor(projectRoot: string) {
    this.basePath = join(projectRoot, '.orchestra');
    mkdirSync(join(this.basePath, 'passes'), { recursive: true });
    mkdirSync(join(this.basePath, 'summaries'), { recursive: true });
  }

  private atomicWrite(filePath: string, data: string): void {
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, data);
    renameSync(tmp, filePath);
  }

  saveState(state: WorkflowState): void {
    this.atomicWrite(
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
    return state !== null && state.status === 'running';
  }

  addPassSummary(summary: PassSummary): void {
    this.atomicWrite(
      join(this.basePath, 'summaries', `pass-${String(summary.passNumber).padStart(3, '0')}.json`),
      JSON.stringify(summary, null, 2),
    );
  }

  loadPassSummaries(): PassSummary[] {
    const dir = join(this.basePath, 'summaries');
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

  addPassOutput(passNumber: number, output: unknown): void {
    this.atomicWrite(
      join(this.basePath, 'passes', `pass-${String(passNumber).padStart(3, '0')}.json`),
      JSON.stringify(output, null, 2),
    );
  }

  saveConversation(messages: Message[]): void {
    this.atomicWrite(
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
    for (const sub of ['state.json', 'conversation.json', 'passes', 'summaries']) {
      const path = join(this.basePath, sub);
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
    }
    mkdirSync(join(this.basePath, 'passes'), { recursive: true });
    mkdirSync(join(this.basePath, 'summaries'), { recursive: true });
  }
}
