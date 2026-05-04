# M3 Status — Skill + Install + Verify

**Status:** shipped. Ready for v0.2.0 once M4 (field report) lands.
**Tag:** none yet (v0.2.0 ships at end of M4).

## What landed

A self-contained install / verify / uninstall surface plus the canonical
captain skill body and per-host templates. From a built `crew-mcp`
binary the user can now run `crew install --target <host>` and the host
CLI gets both the MCP block and the rendered skill, with a manifest at
`~/.crew/install.json` so `crew verify` and `crew uninstall` know what
to operate on.

### New CLI commands

| Command | Purpose |
|---|---|
| `crew install --target {claude-code\|codex\|gemini\|all}` | Write MCP block + skill file; record install in `~/.crew/install.json`. |
| `crew verify` | Compare every installed skill's `mcp__crew__*` references against the static tool catalog. |
| `crew uninstall --target {host\|all}` | Reverse the install: remove MCP block, delete skill file, drop from manifest. |

All commands are idempotent. `--target all` enumerates every registered
host. Install detects whether the host CLI's binary is on PATH for
`--target all` (and skips uninstalled hosts) but force-installs for
explicit single-host targets (the user may be installing in advance).

### New skill artifacts

- `skills/crew-captain.body.md` — canonical body, ~80% migrated from
  v0.1's `captain-system.ts` (via the `v0.1-tui` git tag) with the
  PRODUCT_VISION edits applied: retired tool refs dropped; reframed
  from "you are the captain" to portable instructions; dispatch-vs-inline
  heuristic added up top; explicit escape-hatch paragraph; explicit
  merge-boundary rule. The static body is the single source of
  orchestration playbook truth.
- `skills/targets/{claude-code,codex,gemini}.md.tmpl` — per-host
  wrappers. Claude Code template adds frontmatter (`name`,
  `description`) tuned for skill auto-match. Codex + Gemini templates
  add a one-line opening framing.

### New install module — `src/install/`

```
src/install/
├── skill-renderer.ts       # body + template + tool list → final skill
├── crew-binary.ts          # resolves the absolute crew binary path
├── tool-catalog.ts         # static catalog mirroring serve.ts
├── install-manifest.ts     # ~/.crew/install.json read/write/atomic
└── hosts/
    ├── types.ts            # HostAdapter interface
    ├── claude-code.ts      # JSON merge (~/.claude.json)
    ├── codex.ts            # TOML merge (~/.codex/config.toml)
    ├── gemini.ts           # JSON merge (~/.gemini/settings.json)
    └── index.ts            # adapter registry
```

The `HostAdapter` interface is the per-host abstraction — config path,
skill path, idempotent merge / remove / has helpers, plus best-effort
detection (binary on PATH? CLI running?).

### TOML handling — no parser dependency

Codex's config is TOML, but rather than add a TOML parser dependency we
hand-roll a section-based merge: locate `[mcp_servers.crew]` by header
line, scan forward to the next `^[` or EOF, replace in place. This
preserves comments, formatting, and unrelated sections that any
parse → mutate → stringify round-trip would erase. The trade-off:
`tomlString()` covers the basic-string escape table (backslash, quote,
\n, \r, \t) which suffices for absolute paths + simple args. The
alternatives — `@iarna/toml` or `smol-toml` — would force-rewrite the
whole file when we touch one block.

## Tests

- `test/install/skill-renderer.test.ts` (8 cases) — placeholder
  substitution, tool list formatting, real-template rendering for all
  three hosts, no leftover placeholders, package-root resolution.
- `test/install/hosts/codex.test.ts` (16 cases) — TOML merge/remove
  edge cases: empty file, fresh install, replace-in-place, replace
  with following section, idempotency, comment preservation, Windows
  path escaping, internal section locator.
- `test/install/hosts/claude-code.test.ts` (12 cases) — JSON merge,
  unrelated-key preservation, idempotency, defensive parsing.
- `test/install/hosts/gemini.test.ts` (7 cases) — JSON merge,
  path correctness, idempotency.
- `test/install/tool-catalog.test.ts` (1 case) — parity-test connecting
  an in-memory MCP client to `buildCrewMcpServer()` and asserting
  `listTools()` matches the static catalog. Drift here is what
  `crew verify` exists to catch and we catch it at build time.
- `test/cli/commands/install-uninstall-verify.test.ts` (15 cases) —
  end-to-end: install writes skill+config+manifest, install all,
  install is idempotent, install preserves unrelated keys, verify
  ok after install, verify drift on missing skill / corrupted skill /
  removed config block, uninstall reverses install, uninstall
  is idempotent, uninstall preserves unrelated mcpServers entries,
  comma-separated targets, unknown targets throw.

Suite: 479 passed / 3 skipped / 0 failed across 46 files. Lint clean.
Build clean (159.85 KB ESM bundle, +21 KB over M2).

## Acceptance map (vs IMPLEMENTATION_PLAN.md)

| Criterion | Status |
|---|---|
| `crew install --target codex` writes MCP block + skill | done |
| Same for `--target claude-code` and `--target gemini` | done |
| `crew verify` passes after install | done |
| `crew uninstall` cleanly removes | done |
| Re-running `crew install` is idempotent | done (test: install twice → same end state) |
| `crew install --target all` auto-detects installed hosts | done |
| Restart-warning UX | done (best-effort `ps` scan, suppressible via skipRunningCheck) |
| `~/.crew/install.json` tracks installed targets + version | done (schema v1) |
| Manual smoke in Codex / Claude Code / Gemini | deferred — needs npm-install path; M4's dogfooding does this |

## Decisions worth noting

1. **Hand-rolled TOML block-merger.** Adding a TOML parser dep would
   force-rewrite the entire codex config and lose user comments /
   formatting. Locate-by-header + scan-to-next-section preserves
   everything verbatim and is testable in 16 unit cases.

2. **Static tool catalog with parity test.** `src/install/tool-catalog.ts`
   mirrors the tools registered in `serve.ts`. The parity unit test
   connects an in-memory client to a real `buildCrewMcpServer()` and
   asserts `listTools()` matches. Adding a tool requires touching both
   files; the test fails loudly if you forget either.

3. **Detection vs force at install time.** `--target all` skips hosts
   whose binary isn't on PATH (the user almost certainly doesn't
   want crew installed for a host they don't use). Explicit single-host
   targets force-install regardless (the user might be installing in
   advance of the host CLI). Both behaviors are tested; the
   `forceWithoutBinary` flag is the test seam.

4. **Skill description as one-source.** `SKILL_DESCRIPTION` lives in
   `skill-renderer.ts` rather than per-template. Claude Code is the
   only host whose template substitutes `{{DESCRIPTION}}` (it's the
   skill auto-match phrase); the other templates ignore it. Keeping
   the constant central means the description tuning happens in code,
   not in three .tmpl files.

5. **Install manifest schema v1, no migrations.** Mirrors the
   run-state schema decision in M2. The reader throws on unknown
   versions; if we ever bump v2 the migration story can be added then.

6. **`process.execPath + argv[1]` for binary resolution.** Avoids
   detecting npm shims explicitly. argv[1] is whatever script Node
   was invoked with — under npm's bin shim it resolves to the real
   `dist/index.js` path. Cross-platform: works on Mac/Linux and
   Windows (npm's `.cmd` wrapper still spawns Node with the script
   path). Tests inject a stub via `resolveCrewBinary`.

## Carry-forward for M4

The substrate is now end-to-end installable. M4 builds the eval +
field report on top:

- 20-task fixture spanning easy / medium / hard.
- A/B harness: with-skill vs. empty-skill (control), same MCP server
  for both arms.
- Metrics: dispatch decisions, review-pass count, completion rate,
  wall time, token spend.
- Two weeks of dogfooding on real work.
- `docs/FIELD_REPORT.md` — the portfolio artifact.
- Tag `v0.2.0`.

## Manual smoke (deferred to M4)

The "manual smoke in real Codex / Claude Code / Gemini sessions"
criterion still requires installing the package globally
(`npm link` or `npm install -g`) and running `crew install` against
a real host CLI. M4's dogfooding phase is where this happens
naturally. The integration test path covers everything except the
host CLI's actual MCP-spawn handshake, which is the same code path
the M2 subprocess test already verifies.
