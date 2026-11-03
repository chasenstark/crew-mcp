# Changelog

These entries describe repository versions. Registry publication is a separate
step; check npm dist-tags for the version available through `latest`.

## 0.26.0 — 2026-11-03

- Expose repository-context capabilities in agent inventory: workspace access,
  supplied text only, or unknown.
- Warn when dispatching or continuing supplied-text workers, including panel
  reviewers, so a worktree binding is not mistaken for access to its contents.
- Preserve supplied-text execution and prompts; automatic file/diff injection
  remains unimplemented.

## 0.25.0 — 2026-11-02

- Accept canonical Codex task names when registering native reviewer wake
  claims, resolving them through bounded public parent/repository metadata.
- Keep reviewer collection on the native wait path when identity cannot be
  verified; use the returned UUID for successful registration lifecycles.

## 0.24.0 — 2026-09-02

- Record bounded per-poll diagnostics for PR watches, including polling mode,
  API cost, changed PRs, timing, and incomplete-evidence reasons.
- Add `crew-pr-watch polls` and expose recent diagnostics in watch status.
- Add Linux and macOS CI on Node 20 and 22 for tests, type checking, builds,
  and a packed-package install/verify smoke using temporary host configuration.
  Published 2026-11-02.

## 0.23.0 — 2026-09-02

- Detect review-bot comment edits and review-thread resolution changes during
  delta polling, including edits that do not change the PR's update timestamp.
- Add configurable bot detection and ignore rules, and supersede older pending
  events when a comment is edited.
- Correct backward-pagination completeness checks and allow acknowledged bot
  comments to stop blocking terminal-green evaluation.
- Existing watches with a changed policy must be cancelled and started again.

## 0.22.0 — 2026-09-02

- Reduce API cost for large PR stacks with lightweight probes, cached detail
  observations, changed-PR refreshes, and periodic full refreshes.
- Require a fresh complete observation before declaring terminal green.
- Account for forced refresh costs and fall back to actual poll costs when
  observation-cache persistence fails.

## 0.21.0 — 2026-09-02

- Provision write-run worktree dependencies at dispatch through `provision_deps`
  and the per-machine `deps.provision` setting.
- In automatic mode, clone compatible `node_modules` with copy-on-write support;
  dependency installation requires an explicit policy choice.
- Report provisioning outcomes, skipped install scripts, and dependency drift
  on continuation in run state and captain-facing warnings.
