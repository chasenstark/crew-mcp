import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getNativeReviewerWakeStatus,
  recordNativeReviewerCompletion,
  registerNativeReviewer,
  resolveNativeReviewerWake,
} from '../../src/codex/native-reviewer-wake.js';
import { CodexQueueWakeError } from '../../src/codex/queue-wake.js';

describe('native reviewer wake claims', () => {
  const threadId = '019f5d0f-a60c-7d53-9f35-2036d92d71ec';
  const agentId = '019f5d0f-a60c-7d53-9f35-2036d92d71ed';
  let crewHome: string;
  let repoRoot: string;
  let otherRepoRoot: string;

  beforeEach(() => {
    crewHome = mkdtempSync(join(tmpdir(), 'crew-native-reviewer-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'crew-native-reviewer-repo-'));
    otherRepoRoot = mkdtempSync(join(tmpdir(), 'crew-native-reviewer-other-'));
  });

  afterEach(() => {
    rmSync(crewHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(otherRepoRoot, { recursive: true, force: true });
  });

  it('queues once after a registered reviewer completes and resolves idempotently', async () => {
    const queueWake = vi.fn(async () => ({ queued: true as const }));
    const target = { crewHome, repoRoot, threadId, agentId };

    await expect(registerNativeReviewer(target, { queueWake })).resolves.toMatchObject({
      state: 'registered',
      action: 'registered',
    });
    await expect(recordNativeReviewerCompletion(target, { queueWake })).resolves.toMatchObject({
      state: 'delivered',
      action: 'wake_queued',
    });
    await recordNativeReviewerCompletion(target, { queueWake });
    expect(queueWake).toHaveBeenCalledTimes(1);
    expect(queueWake).toHaveBeenCalledWith({ threadId, agentId });

    await expect(resolveNativeReviewerWake(target)).resolves.toMatchObject({
      state: 'resolved',
      action: 'resolved',
    });
    await expect(resolveNativeReviewerWake(target)).resolves.toMatchObject({
      state: 'resolved',
      action: 'resolved',
    });
  });

  it('closes the completion-before-registration race with a short tombstone', async () => {
    const queueWake = vi.fn(async () => ({ queued: true as const }));
    const target = { crewHome, repoRoot, threadId, agentId };

    await expect(recordNativeReviewerCompletion(target, { queueWake })).resolves.toMatchObject({
      state: 'tombstone',
      action: 'completion_recorded',
    });
    expect(queueWake).not.toHaveBeenCalled();

    await expect(registerNativeReviewer({
      ...target,
      panelId: 'panel-1',
    }, { queueWake })).resolves.toMatchObject({
      state: 'delivered',
      action: 'wake_queued',
    });
    expect(queueWake).toHaveBeenCalledTimes(1);
  });

  it('retains an ambiguous delivery claim and never blindly retries it', async () => {
    const queueWake = vi.fn(async () => {
      throw new CodexQueueWakeError('timed out', 'ambiguous');
    });
    const target = { crewHome, repoRoot, threadId, agentId };
    await registerNativeReviewer(target, { queueWake });

    await expect(recordNativeReviewerCompletion(target, { queueWake })).resolves.toMatchObject({
      state: 'delivery_ambiguous',
      action: 'delivery_ambiguous',
    });
    await registerNativeReviewer(target, { queueWake });
    await recordNativeReviewerCompletion(target, { queueWake });
    expect(queueWake).toHaveBeenCalledTimes(1);
  });

  it('retries only a definitive queue rejection', async () => {
    const queueWake = vi.fn()
      .mockRejectedValueOnce(new CodexQueueWakeError('rejected'))
      .mockResolvedValueOnce({ queued: true as const });
    const target = { crewHome, repoRoot, threadId, agentId };
    await registerNativeReviewer(target, { queueWake });

    await expect(recordNativeReviewerCompletion(target, { queueWake })).resolves.toMatchObject({
      state: 'completed',
      action: 'delivery_failed',
    });
    await expect(registerNativeReviewer(target, { queueWake })).resolves.toMatchObject({
      state: 'delivered',
      action: 'wake_queued',
    });
    expect(queueWake).toHaveBeenCalledTimes(2);
  });

  it('expires and prunes an unmatched completion tombstone after ten minutes', async () => {
    let current = new Date('2026-08-31T12:00:00.000Z');
    const now = () => current;
    const queueWake = vi.fn(async () => ({ queued: true as const }));
    const target = { crewHome, repoRoot, threadId, agentId };
    await recordNativeReviewerCompletion(target, { now, queueWake });

    current = new Date('2026-08-31T12:10:00.001Z');
    await expect(registerNativeReviewer(target, { now, queueWake })).resolves.toMatchObject({
      state: 'registered',
      action: 'registered',
    });
    expect(queueWake).not.toHaveBeenCalled();
  });

  it('keeps wrong-repo events from claiming or waking a registered reviewer', async () => {
    const queueWake = vi.fn(async () => ({ queued: true as const }));
    await registerNativeReviewer({ crewHome, repoRoot, threadId, agentId }, { queueWake });

    await expect(recordNativeReviewerCompletion({
      crewHome,
      repoRoot: otherRepoRoot,
      threadId,
      agentId,
    }, { queueWake })).resolves.toMatchObject({ action: 'ignored_wrong_repo' });
    expect(queueWake).not.toHaveBeenCalled();
  });

  it('lets a user turn resolve while delivery is in flight without reopening the claim', async () => {
    let release!: () => void;
    let started!: () => void;
    const deliveryStarted = new Promise<void>((resolveStarted) => {
      started = resolveStarted;
    });
    const deliveryRelease = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    const queueWake = vi.fn(async () => {
      started();
      await deliveryRelease;
      return { queued: true as const };
    });
    const target = { crewHome, repoRoot, threadId, agentId };
    await registerNativeReviewer(target, { queueWake });

    const completing = recordNativeReviewerCompletion(target, { queueWake });
    await deliveryStarted;
    await resolveNativeReviewerWake(target);
    release();
    await expect(completing).resolves.toMatchObject({ state: 'resolved' });
    await expect(getNativeReviewerWakeStatus(target)).resolves.toMatchObject({
      state: 'resolved',
      action: 'resolved',
    });
  });
});
