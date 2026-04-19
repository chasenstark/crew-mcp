import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StateStore } from '../../src/state/store.js';
import type { WorkflowState } from '../../src/state/types.js';

function writeRawStateFile(projectRoot: string, raw: unknown): void {
  const crewDir = join(projectRoot, '.crew');
  mkdirSync(crewDir, { recursive: true });
  writeFileSync(join(crewDir, 'state.json'), JSON.stringify(raw, null, 2), 'utf-8');
}

describe('StateStore migration', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'crew-migration-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('loads a v3 state file and upgrades schemaVersion to 4', () => {
    const v3State: WorkflowState = {
      schemaVersion: 3,
      executionMode: 'judgment',
      status: 'interrupted',
      userRequest: 'build a thing',
      decomposition: { reasoning: 'r', tasks: [], suggestedOrder: [] },
      currentTaskIndex: 0,
      passes: [],
    };
    writeRawStateFile(projectRoot, v3State);

    const store = new StateStore(projectRoot);
    const loaded = store.loadState();

    expect(loaded).not.toBeNull();
    expect(loaded?.schemaVersion).toBe(4);
    expect(loaded?.userRequest).toBe('build a thing');
    expect(loaded?.executionMode).toBe('judgment');
  });

  it('loads a state file missing schemaVersion as v3 and upgrades it', () => {
    writeRawStateFile(projectRoot, {
      status: 'running',
      userRequest: 'legacy',
      decomposition: { reasoning: '', tasks: [], suggestedOrder: [] },
      currentTaskIndex: 0,
      passes: [],
    });

    const store = new StateStore(projectRoot);
    const loaded = store.loadState();

    expect(loaded?.schemaVersion).toBe(4);
    expect(loaded?.userRequest).toBe('legacy');
  });

  it('round-trips v3 state → v4 persistence when re-saved', () => {
    const v3State: WorkflowState = {
      schemaVersion: 3,
      executionMode: 'judgment',
      status: 'running',
      userRequest: 'round-trip',
      decomposition: { reasoning: '', tasks: [], suggestedOrder: [] },
      currentTaskIndex: 0,
      passes: [],
    };
    writeRawStateFile(projectRoot, v3State);

    const store = new StateStore(projectRoot);
    const loaded = store.loadState();
    expect(loaded?.schemaVersion).toBe(4);

    store.saveState(loaded!);

    const rawDisk = JSON.parse(
      readFileSync(join(projectRoot, '.crew', 'state.json'), 'utf-8'),
    );
    expect(rawDisk.schemaVersion).toBe(4);
    expect(rawDisk.userRequest).toBe('round-trip');
  });

  it('writes schemaVersion 4 for fresh saves even when the caller omits it', () => {
    const store = new StateStore(projectRoot);
    store.saveState({
      status: 'running',
      userRequest: 'fresh',
      decomposition: { reasoning: '', tasks: [], suggestedOrder: [] },
      currentTaskIndex: 0,
      passes: [],
    });

    const rawDisk = JSON.parse(
      readFileSync(join(projectRoot, '.crew', 'state.json'), 'utf-8'),
    );
    expect(rawDisk.schemaVersion).toBe(4);
  });

  it('refuses to load a state file with a newer unknown schemaVersion', () => {
    writeRawStateFile(projectRoot, {
      schemaVersion: 99,
      status: 'running',
      userRequest: 'from the future',
      decomposition: { reasoning: '', tasks: [], suggestedOrder: [] },
      currentTaskIndex: 0,
      passes: [],
    });

    const store = new StateStore(projectRoot);
    expect(store.loadState()).toBeNull();
  });

  it('renames a legacy conversation.json on boot and logs once', () => {
    const crewDir = join(projectRoot, '.crew');
    mkdirSync(crewDir, { recursive: true });
    const legacyPath = join(crewDir, 'conversation.json');
    writeFileSync(legacyPath, JSON.stringify([{ role: 'user', content: 'hi' }]), 'utf-8');

    new StateStore(projectRoot);

    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(join(crewDir, 'conversation.legacy.json'))).toBe(true);
  });

  it('does nothing when no legacy conversation.json exists', () => {
    const crewDir = join(projectRoot, '.crew');
    new StateStore(projectRoot);
    expect(existsSync(join(crewDir, 'conversation.legacy.json'))).toBe(false);
  });
});
