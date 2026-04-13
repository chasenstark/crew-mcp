import type { WorktreeManager } from './worktree.js';

export async function mergeAllWorktrees(
  worktreeManager: WorktreeManager,
  taskIds: string[],
  targetBranch: string = 'main',
): Promise<{ merged: string[]; failed: { taskId: string; error: string }[] }> {
  const merged: string[] = [];
  const failed: { taskId: string; error: string }[] = [];
  for (const taskId of taskIds) {
    try {
      await worktreeManager.mergeWorktree(taskId, targetBranch);
      merged.push(taskId);
    } catch (err) {
      failed.push({ taskId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { merged, failed };
}
