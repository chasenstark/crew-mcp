export function validateRunPanelPreflight(
  reviewers: readonly unknown[],
  maxReviewers = 20,
): void {
  if (reviewers.length > maxReviewers) {
    throw new Error(
      `run_panel.too_many_reviewers: ${reviewers.length} reviewers exceeds runtime cap ${maxReviewers}`,
    );
  }
}
