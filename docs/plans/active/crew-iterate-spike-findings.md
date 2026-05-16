# crew:iterate spike findings (2026-05-14)

Resolves Open Questions F7 (nested-skill-path host support) and F8
(umbrella co-load behavior) from
[`crew-iterate-skill.md`](./crew-iterate-skill.md). Investigation
combined source-code reads of each host's skill loader plus official
docs.

## Summary

All three hosts support multiple skills per plugin, but each uses a
DIFFERENT layout. The naive nested layout proposed in the plan
(`<host>/skills/crew/iterate/SKILL.md`) only works in Codex; Claude
Code requires a plugin manifest + sibling-flat layout, and Gemini
requires the same sibling-flat layout under an extension's `skills/`
subdirectory. None of the three hosts co-loads the umbrella skill body
when a sibling/sub-skill is invoked — Claude Code keeps full bodies
out of context until a skill activates, Codex injects only
name+description+path, and Gemini does the same. **The plan must
treat `crew:iterate` as a peer of `crew`, not as content the umbrella
loads for it.**

## Per-host findings

### Claude Code

**Nested skill support**: YES via plugin layout, NO via raw nesting.

**Path** (proposed): the current `~/.claude/skills/crew/SKILL.md`
layout is a "personal skill" — it has no plugin manifest, so it
cannot host sub-skills. To ship two skills under one namespace the
install must convert to a **plugin** layout:

```
~/.claude/skills/crew/
  .claude-plugin/plugin.json   { "name": "crew", "version": "x.y.z" }
  skills/
    crew/SKILL.md              # umbrella  -> /crew:crew
    iterate/SKILL.md           # sub-skill -> /crew:iterate
```

The first directory under `skills/` becomes the skill's bare name; the
plugin manifest's `name` becomes the prefix. The combined namespaced
form is `<plugin-name>:<skill-dir-name>`. Skills nested more than one
directory deep inside `skills/` are NOT discovered.

**Frontmatter `name:` field**: the docs say `name` is optional and
defaults to the directory name; when present it must match the
directory name (lowercase, hyphens, digits, max 64 chars). Colon-
namespacing in `name:` is **not supported** — the runtime prefix
comes from `plugin.json`'s `name` field, not from the SKILL.md
frontmatter.

So the file at `skills/iterate/SKILL.md` should have either
`name: iterate` or omit `name:` entirely. The user sees and invokes
`/crew:iterate`.

**Co-load with umbrella**: NO. The skills doc is explicit: "skill
descriptions are loaded into context so Claude knows what's available,
but full skill content only loads when invoked." Invoking
`/crew:iterate` injects only that skill's body. The umbrella `crew`
body is NOT pulled into context just because they share a plugin.

**Evidence**:
- Path layout: https://code.claude.com/docs/en/plugins — "skills live
  in the `skills/` directory. Each skill is a folder containing a
  `SKILL.md` file. The folder name becomes the skill name, prefixed
  with the plugin's namespace (`hello/` in a plugin named
  `my-first-plugin` creates `/my-first-plugin:hello`)."
- Frontmatter rules: https://code.claude.com/docs/en/skills — "name
  (No required) Display name for the skill. If omitted, uses the
  directory name. Lowercase letters, numbers, and hyphens only (max
  64 characters)."
- Co-load: same doc — "In a regular session, skill descriptions are
  loaded into context so Claude knows what's available, but full
  skill content only loads when invoked."
- Local filesystem evidence: the only multi-skill plugin installed
  here (`caveman` at
  `~/.claude/plugins/cache/caveman/caveman/63e797cd753b/`) uses
  exactly the `plugins/caveman/skills/<name>/SKILL.md` layout with
  bare `name:` frontmatter.
- The `pr-review-toolkit:review-pr` / `code-review:code-review`
  entries in this session's available-skills list are SLASH COMMANDS
  (`commands/review-pr.md`), NOT SKILL.md skills — verified by
  inspecting
  `~/.claude/plugins/cache/claude-code-plugins/pr-review-toolkit/1.0.0/`.
  They prove `<plugin>:<name>` namespacing exists for commands but
  are NOT proof for skills.

### Codex

**Nested skill support**: YES. Codex's loader (`codex-rs/core-skills/
src/loader.rs`) walks each skills root up to **6 directories deep**
(constant `MAX_SCAN_DEPTH: usize = 6`) looking for `SKILL.md`. Any
subtree is searched.

**Path** (proposed): EITHER layout works in Codex:

```
~/.codex/skills/crew/SKILL.md             # umbrella
~/.codex/skills/crew/iterate/SKILL.md     # sub-skill, nested
```

OR the plugin layout, which gives Codex an explicit namespace:

```
~/.codex/skills/crew/
  .codex-plugin/plugin.json   { "name": "crew" }
  skills/
    iterate/SKILL.md          # auto-namespaced as crew:iterate
```

With a plugin manifest, Codex computes the skill name as
`<plugin-manifest-name>:<bare-name>`. Without a manifest, the bare
`name:` from frontmatter is used as-is (colons allowed: `name:
crew:iterate` becomes literal `crew:iterate`).

**Frontmatter `name:` field**:
- Without plugin manifest: `name: crew:iterate` (literal, max 64
  chars). Verified in
  `codex-rs/core-skills/src/loader.rs::parse_skill_file` —
  `base_name` is taken straight from `name:` if present, otherwise
  derived from the parent directory name.
- With plugin manifest: `name: iterate` and let
  `namespaced_skill_name` prepend `crew:`.

**Co-load with umbrella**: NO. Codex's render layer
(`codex-rs/core-skills/src/render.rs`) injects ONLY name +
description + file path of every discovered skill into the system
prompt at session start (`render_available_skills_body`). The skill
BODY only enters context when the model "decides to use a skill"
and explicitly opens the `SKILL.md` file. From the system prompt
text: "Skill bodies live on disk at the listed paths." So invoking
`crew:iterate` does NOT auto-load the umbrella `crew` body.

**Evidence**:
- Loader source:
  https://github.com/openai/codex/blob/main/codex-rs/core-skills/src/loader.rs
  (`MAX_SCAN_DEPTH = 6`, BFS-walks subdirectories).
- Plugin namespace logic:
  https://github.com/openai/codex/blob/main/codex-rs/utils/plugins/src/plugin_namespace.rs
  — recognizes both `.codex-plugin/plugin.json` and
  `.claude-plugin/plugin.json` as plugin markers; uses nearest
  ancestor.
- Render / context-injection:
  https://github.com/openai/codex/blob/main/codex-rs/core-skills/src/render.rs
  — only metadata in system prompt; bodies opened on demand.
- Empirical: `~/.codex/skills/.system/` ships 4 SKILL.md files in
  flat subdirs (`skill-creator/`, `plugin-creator/`,
  `skill-installer/`, etc.) with bare `name:` and no namespacing —
  consistent with discovery walking the tree.

### Gemini CLI

**Nested skill support**: NO for the proposed nested layout.

Gemini's loader
(`packages/core/src/skills/skillLoader.ts::loadSkillsFromDir`) uses
glob `['SKILL.md', '*/SKILL.md']` — exactly two patterns. SKILL.md
at the skills root, or one directory deep. **Files at 2+ levels
deep are skipped.**

Gemini also has a sanitizer: `frontmatter.name.replace(/[:\\/<>*?"|]/g,
'-')` — so `name: crew:iterate` would be rendered as `crew-iterate`,
silently losing the namespace.

**Path** (proposed): the current crew-mcp adapter writes to
`~/.gemini/extensions/crew/SKILL.md`. But extensions load skills from
`<ext>/skills/...`, not from the extension root
(`extension-manager.ts:921: loadSkillsFromDir(path.join(
effectiveExtensionPath, 'skills'))`). So the existing Gemini
install may not actually be loading the crew skill today as a Gemini
"extension skill" — it's relying on either: (a) a separate user-tier
discovery, (b) a stale code path, or (c) it simply isn't being
loaded. **This is tangential but worth surfacing — the spike
question forced me to read the Gemini loader and the layout looks
wrong.**

For multi-skill support, the correct Gemini layout is:

```
~/.gemini/extensions/crew/
  gemini-extension.json        (required extension manifest)
  skills/
    crew/SKILL.md              # umbrella
    iterate/SKILL.md           # sub-skill
```

OR, sidestep the extension layout entirely and use User Skills:

```
~/.gemini/skills/crew/SKILL.md
~/.gemini/skills/crew-iterate/SKILL.md   # FLAT, not nested
```

(In the user-skills tier, the convention is one directory per skill.
Two skills = two sibling directories.)

**Frontmatter `name:` field**: bare name only; colons get sanitized
to hyphens. `name: crew-iterate` (NOT `crew:iterate`) — and there is
NO equivalent of Codex/Claude's plugin namespacing. Two skills from
the same extension are siblings in the same listing, with no
`<ext>:<skill>` prefix in their display name (verified in
`skillLoader.ts`: only the sanitized `name` is used; `extensionName`
is metadata only).

**Co-load with umbrella**: NO. From `docs/cli/skills.md`: "At the
start of a session, Gemini CLI scans the discovery tiers and injects
the name and description of all enabled skills into the system
prompt. … Upon your approval [of an activation request]: The
SKILL.md body and folder structure is added to the conversation
history." Only the activated skill's body is injected. The umbrella
isn't co-loaded.

**Evidence**:
- Discovery glob:
  https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/skills/skillLoader.ts
  — `const pattern = ['SKILL.md', '*/SKILL.md']`.
- Name sanitizer: same file —
  `frontmatter.name.replace(/[:\\/<>*?"|]/g, '-')`.
- Extension skill path:
  https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/extension-manager.ts
  line 921 — `loadSkillsFromDir(path.join(effectiveExtensionPath,
  'skills'))`.
- Lifecycle:
  https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md
  — "**Injection**: Upon your approval: The `SKILL.md` body and
  folder structure is added to the conversation history."

## Recommended path for the plan

The plan's "Open Question 2" hypothesis (nested layout
`~/.<host>/skills/crew/iterate/SKILL.md`) **partially holds for
Codex only**. For Claude Code and Gemini, the install must change
shape.

### Recommended layout — single source of truth

For Claude Code, convert the `~/.claude/skills/crew/` directory into
a plugin:

```
~/.claude/skills/crew/
  .claude-plugin/plugin.json   { "name": "crew", "version": "<pkg.version>" }
  skills/
    crew/SKILL.md              # name: crew         -> /crew:crew
    iterate/SKILL.md           # name: iterate      -> /crew:iterate
```

For Codex, the cleanest match — and the one that interops with the
above via Codex's `.claude-plugin/plugin.json` support — is the same
plugin layout under `~/.codex/skills/crew/`. Codex's
`plugin_namespace.rs` accepts EITHER `.codex-plugin/plugin.json` OR
`.claude-plugin/plugin.json`, so a single plugin manifest can serve
both hosts (or write both manifests for clarity).

```
~/.codex/skills/crew/
  .codex-plugin/plugin.json    { "name": "crew" }   (or .claude-plugin/, both work)
  skills/
    crew/SKILL.md              -> crew:crew  (and crew:iterate)
    iterate/SKILL.md
```

For Gemini, the simplest layout is **flat sibling user-skills**:

```
~/.gemini/skills/crew/SKILL.md             # name: crew
~/.gemini/skills/crew-iterate/SKILL.md     # name: crew-iterate   (NOT crew:iterate)
```

The crew-mcp Gemini adapter would move from
`~/.gemini/extensions/crew/SKILL.md` to `~/.gemini/skills/crew/SKILL.md`,
which is the canonical user-skills location anyway. (Worth
confirming the existing install actually works today — see Open
Uncertainty 1 below.)

### Cross-host name handling

The plan's frontmatter `name: crew:iterate` works as-is in **Codex
only**. Claude Code requires bare `name: iterate` (with the namespace
coming from `.claude-plugin/plugin.json`). Gemini will silently
sanitize the colon to a hyphen and display the skill as
`crew-iterate`.

The user-facing slash-trigger therefore differs per host:
- Claude Code: `/crew:iterate`
- Codex: `crew:iterate` (or `$crew:iterate` mention)
- Gemini: `crew-iterate` (NOT `crew:iterate`)

The skill's auto-load `description:` text is what actually triggers
loads, so the slash names matter mainly for explicit invocation. The
plan should be updated to note the trigger-name divergence.

### Co-load: NONE of the three hosts co-loads the umbrella

This is decisive for Open Question 6. The plan's Option (c)
("preamble + trust the captain to load both") is **not safe** if
"trust the captain to load both" relies on the host automatically
loading the umbrella. It does not.

Two viable approaches:

1. **Duplicate the load-bearing rules** at the top of
   `crew-iterate.body.md` — the merge boundary, dispatch lifecycle,
   and escape hatch. ~30 lines per the plan's own estimate. This is
   the safe choice and matches Open Question 9's fallback.

2. **Two-skill description matchers** that always co-trigger.
   E.g., the iterate skill's description explicitly says "this skill
   extends `crew`; load `crew` first if not already loaded." If the
   captain follows the directive, both bodies end up in context. But
   this is a behavioral hope, not a host guarantee, and across model
   evals it will fail some fraction of the time.

**Recommendation**: do (1). The cost is ~30 lines of duplicated
prose; the safety upside is large. Phrase the duplicated section as
"This skill is independent of the umbrella `crew` body; the
following safety invariants are restated here so it works standalone."

## Open uncertainties

These need empirical confirmation by the human before Phase 1
implementation locks in:

1. **Is the current Gemini install actually loading?** The crew-mcp
   adapter writes to `~/.gemini/extensions/crew/SKILL.md`, but
   Gemini's extension loader only reads `<ext>/skills/`. There's no
   `gemini-extension.json` at `~/.gemini/extensions/crew/`, so this
   may never have registered as an extension. The skill probably
   either (a) isn't loaded today, or (b) loads via a tier I missed.
   To verify: run `gemini /skills list` and check whether `crew`
   appears. If it doesn't, the current install is broken and the
   Gemini smoke test in `docs/status/` may have only validated the
   MCP config side, not the skill side.

2. **Claude Code: does the `crew` SKILL.md need to move from
   `~/.claude/skills/crew/SKILL.md` to
   `~/.claude/skills/crew/skills/crew/SKILL.md` when adding
   `.claude-plugin/plugin.json`?** The plugin layout requires
   `<plugin>/skills/<name>/SKILL.md`, but it's unclear whether a
   plugin can ALSO host a top-level SKILL.md at the plugin root for
   back-compat. To verify: write the plugin manifest at
   `~/.claude/skills/crew/.claude-plugin/plugin.json` plus a stub
   `~/.claude/skills/crew/skills/test-spike/SKILL.md` with `name:
   test-spike` and check whether `/crew:test-spike` shows up in
   `/skills` (or in the available-skills listing the next session
   start). If yes, the plugin layout works and the umbrella body
   must MOVE to `~/.claude/skills/crew/skills/crew/SKILL.md`.

3. **Empirical test the captain can run today** (Claude Code only):
   write
   ```
   ~/.claude/skills/crew-iterate-spike/SKILL.md
   ```
   with frontmatter:
   ```yaml
   ---
   name: crew-iterate-spike
   description: Temporary spike to confirm sibling-skill discovery works. Do not invoke.
   ---
   spike body
   ```
   Start a new Claude Code session; check the available-skills list
   for `crew-iterate-spike` (NOT prefixed with `crew:`). This
   confirms personal-skills siblings work. **Note:** this does NOT
   test the plugin layout from Recommendation A — it only tests the
   simpler flat siblings layout. To clean up:
   `rm -rf ~/.claude/skills/crew-iterate-spike`.

4. **Codex empirical test**: write
   `~/.codex/skills/crew-iterate-spike/SKILL.md` with `name:
   crew-iterate-spike` and check `codex /skills list` (or whatever
   the equivalent listing command is). Same cleanup as above.

5. **Are there extension-bundled `gemini-extension.json`-driven
   skills that ARE loading from `~/.gemini/extensions/`** with a
   different convention than the source code suggests? Possibly the
   docs lag behind code. Worth a quick spot-check on a known
   working Gemini extension (e.g., one of the official Google
   marketplace extensions) before committing to the user-skills
   migration.

## Probe results (Phase 0 - 2026-05-16)

**Execution note:** The setup script was run in the captain's
session after the codex implementer drafted the source-confirmed
outcomes. Empirical verification then performed via fresh
`claude -p` and `codex exec` sessions, which led to substantial
revision of two probe outcomes from source-confirmed PASS to
empirical FAIL.

**Headline finding:** The plan's Claude Code plugin-layout
proposal is **NOT VIABLE** as drafted. Dropping
`.claude-plugin/plugin.json` files in `~/.claude/skills/` does
NOT register a plugin — Claude Code requires explicit installation
via marketplace (`claude plugin install <plugin>@<marketplace>`)
with plugins cached under `~/.claude/plugins/cache/`. The only
viable Claude Code option for crew is **sibling-flat
personal-skills** (no namespace, `/crew` and `/crew-iterate` as
slash triggers). For Codex, the plugin layout DOES work, but for
cross-host simplicity, sibling-flat is recommended everywhere.

### Probe 1 - Gemini current-install validity

**Files written:** none. Direct inspection only; the real install at
`~/.gemini/extensions/crew/` was not modified.

**Method used:** `direct-inspection` + `source-code`.

**Outcome:** FAIL. The current install has only
`~/.gemini/extensions/crew/SKILL.md`; it has no
`gemini-extension.json` and no `skills/` subdirectory. Gemini's
extension manager loads skills from
`path.join(effectiveExtensionPath, 'skills')`, and the skill loader
returns no skills when that directory is absent.

**Source reference:** `google-gemini/gemini-cli`
`packages/cli/src/config/extension-manager.ts:921-923`;
`packages/core/src/skills/skillLoader.ts:121-128`.

**Phase 1 plan impact:** Confirms the relocation concern in
`docs/plans/active/crew-iterate-skill.md:383` and
`docs/plans/active/crew-iterate-skill.md:398`. The Gemini migration
should treat the current extension-root `SKILL.md` as non-loading
skill state unless a user reload proves otherwise.

### Probe 2 - Claude plugin-layout multi-skill discovery

**Files written:** setup script target:
`~/.claude/skills/crew-iterate-spike-plugin/.claude-plugin/plugin.json`,
`~/.claude/skills/crew-iterate-spike-plugin/skills/test-spike-one/SKILL.md`,
and
`~/.claude/skills/crew-iterate-spike-plugin/skills/test-spike-two/SKILL.md`.

**Method used:** `empirical-host-reload` via `claude -p`.

**Outcome:** **FAIL.** A fresh `claude -p` session does NOT
discover `/crew-iterate-spike-plugin:test-spike-one` or
`:test-spike-two`. They are absent from the available-skills
list, while sibling personal-skill paths (probe 3) ARE
discovered in the same listing.

**Root cause:** Claude Code's plugin discovery only loads
plugins INSTALLED through `claude plugin install <plugin>@<marketplace>`.
Installed plugins live at `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`
with their state tracked in `~/.claude/plugins/installed_plugins.json`.
Dropping `.claude-plugin/plugin.json` files under `~/.claude/skills/`
is treated as a personal-skill directory whose root SKILL.md
(if present) would be the personal skill; nested
`skills/<name>/SKILL.md` files inside that directory are
**ignored**. The docs are accurate about the *bundled* plugin
layout but did not specify the *sideload* pathway, which does
not exist.

**Source reference:** Empirical evidence + `claude plugin --help`
shows install/uninstall/enable/disable via marketplaces;
`~/.claude/plugins/installed_plugins.json` tracks the v2 plugin
state.

**Phase 1 plan impact (CRITICAL):** The Claude Code plugin
layout proposal in `docs/plans/active/crew-iterate-skill.md:337–359`
must be dropped. Replace with sibling-flat personal-skills layout:
`~/.claude/skills/crew/SKILL.md` (umbrella, `name: crew`) +
`~/.claude/skills/crew-iterate/SKILL.md` (sub-skill, `name:
crew-iterate`). Slash triggers become `/crew` and `/crew-iterate`
(no namespace). This is identical to the fallback layout the
plan already documented as a backup.

### Probe 3 - Claude sibling-flat fallback

**Files written:** setup script target:
`~/.claude/skills/crew-iterate-spike-flat/SKILL.md`.

**Method used:** `empirical-host-reload` via `claude -p`.

**Outcome:** **PASS (empirical).** Fresh `claude -p` session
discovers `crew-iterate-spike-flat` in the available-skills list.

**Source reference:** Claude Code docs
`https://code.claude.com/docs/en/skills` lines 155-164.

**Phase 1 plan impact:** Keeps the fallback in
`docs/plans/active/crew-iterate-skill.md:1469` through
`docs/plans/active/crew-iterate-skill.md:1475` viable if probe 2
fails under local reload.

### Probe 4 - Codex sibling-flat fallback

**Files written:** setup script target:
`~/.codex/skills/crew-iterate-spike-flat/SKILL.md`.

**Method used:** `empirical-host-reload` via `codex exec`.

**Outcome:** **PASS (empirical).** Codex's skill list includes
`crew-iterate-spike-flat`.

**Source reference:** `openai/codex`
`codex-rs/core-skills/src/loader.rs:121-123`,
`codex-rs/core-skills/src/loader.rs:456-575`, and
`codex-rs/core-skills/src/loader.rs:615-621`.

**Phase 1 plan impact:** Supports the Codex loader assumptions in
`docs/plans/active/crew-iterate-skill.md:378` through
`docs/plans/active/crew-iterate-skill.md:381`.

### Probe 5 - Gemini marketplace extension convention spot-check

**Files written:** none.

**Method used:** `source-code`.

**Outcome:** PASS. The upstream Gemini extension manager hydrates an
extension and then calls `loadSkillsFromDir(path.join(
effectiveExtensionPath, 'skills'))`; the skill loader itself only
globs `SKILL.md` and `*/SKILL.md` under the directory it is handed.
That confirms the spike's claim that extension skills belong under
`<extension>/skills/`, not the extension root.

**Source reference:** `google-gemini/gemini-cli`
`packages/cli/src/config/extension-manager.ts:921-927`;
`packages/core/src/skills/skillLoader.ts:115-128`.

**Phase 1 plan impact:** Reinforces the Gemini relocation plan in
`docs/plans/active/crew-iterate-skill.md:383` through
`docs/plans/active/crew-iterate-skill.md:404`.

### Probe 6 - Claude plugin.json minimum field set

**Files written:** setup script target variants:
`~/.claude/skills/crew-iterate-spike-min-name-version/.claude-plugin/plugin.json`,
`~/.claude/skills/crew-iterate-spike-min-name-only/.claude-plugin/plugin.json`,
and
`~/.claude/skills/crew-iterate-spike-min-empty/.claude-plugin/plugin.json`,
each with a `skills/min-fields/SKILL.md` stub.

**Method used:** `empirical-host-reload` via both `claude -p` and
`codex exec`.

**Outcome (Claude):** **N/A.** None of the three plugin-layout
variants registered, because Claude rejects ALL sideloaded
plugin layouts in `~/.claude/skills/` (see Probe 2). The
minimum-fields question is moot for Claude.

**Outcome (Codex, bonus finding):** **All three variants PASS,
including `{}`.** Codex discovers
`crew-iterate-spike-min-name-version:min-fields`,
`crew-iterate-spike-min-name-only:min-fields`, AND
`crew-iterate-spike-min-empty:min-fields`. Codex's namespace
logic accepts any well-formed `.claude-plugin/plugin.json`
including an empty object — it does NOT validate fields.

**Phase 1 plan impact:** The "Claude plugin minimum field set"
question is moot — Claude doesn't sideload plugins. For Codex,
the `{"name": "...", "version": "..."}` manifest is fine (Codex
is permissive); no field-set adjustment needed.

### Probe 7 - Codex v1/v2 coexistence behavior

**Files written:** setup script target:
`~/.codex/skills/crew-iterate-spike-coex/SKILL.md` (v1 root, no
plugin manifest) and
`~/.codex/skills/crew-iterate-spike-coex/skills/crew-iterate-spike-coex/SKILL.md`
(v2 nested, with `.claude-plugin/plugin.json` in the ancestor —
**note: setup script puts `.claude-plugin/` in the Claude path
for this probe, not the Codex path; Codex's nested SKILL.md
inherits the namespace from the Claude-side manifest because
the codex skill tree is sibling but Codex's plugin_namespace
resolver only searches the SAME tree, so this test was incomplete
on Codex** — see resolution below).

**Method used:** `empirical-host-reload` via `codex exec`.

**Outcome:** **CONFIRMED DOUBLE-LOAD (different namespaces).**
Codex's skill list shows BOTH `crew-iterate-spike-coex` (the v1
root, with bare name) AND
`crew-iterate-spike-coex:crew-iterate-spike-coex` (the v2 nested,
namespaced via the plugin manifest that Codex found via its
6-deep BFS-with-ancestor-search). These are different names so
there's no strict collision, but a user sees two entries that
look like duplicates.

**Phase 1 plan impact:** Reinforces "remove v1 first" rule.
However, with the recommended simplification to **sibling-flat
on ALL hosts** (per Probe 2's revised outcome), Codex would
use `~/.codex/skills/crew/SKILL.md` + `~/.codex/skills/crew-iterate/SKILL.md`
(no plugin manifest), so the plugin-coexistence scenario no
longer applies. The remove-v1-first ordering is still good
hygiene for any future migration scenario.

**Source reference:** `openai/codex`
`codex-rs/core-skills/src/loader.rs:193-205`,
`codex-rs/core-skills/src/loader.rs:220-225`,
`codex-rs/core-skills/src/loader.rs:572-575`, and
`codex-rs/core-skills/src/loader.rs:651-660`.

**Phase 1 plan impact:** Confirms the "remove v1 first" ordering in
`docs/plans/active/crew-iterate-skill.md:1388` through
`docs/plans/active/crew-iterate-skill.md:1392` and the Codex
double-load warning in `docs/plans/active/crew-iterate-skill.md:1421`
through `docs/plans/active/crew-iterate-skill.md:1428`.

### Probe 8 - Claude v1/v2 coexistence behavior

**Files written:** setup script targets:
`~/.claude/skills/crew-iterate-spike-coex/SKILL.md` (v1 personal
root),
`~/.claude/skills/crew-iterate-spike-coex/.claude-plugin/plugin.json`
(plugin manifest), and
`~/.claude/skills/crew-iterate-spike-coex/skills/crew-iterate-spike-coex/SKILL.md`
(v2 nested plugin-style).

**Method used:** `empirical-host-reload` via `claude -p`.

**Outcome:** **The v2 plugin path NEVER registers; only v1
personal-skill loads.** Claude's available-skills list shows
only `crew-iterate-spike-coex` (the v1 root SKILL.md). The v2
nested `crew-iterate-spike-coex:crew-iterate-spike-coex` does
NOT appear, confirming Probe 2's finding that plugin layouts
sideloaded under `~/.claude/skills/` are ignored.

**Phase 1 plan impact:** With the recommended simplification to
sibling-flat on Claude (per Probe 2's revised outcome), there
is no v1/v2 coexistence scenario — both real install paths
become `~/.claude/skills/crew/SKILL.md` and
`~/.claude/skills/crew-iterate/SKILL.md`. The current v1 install
at `~/.claude/skills/crew/SKILL.md` is already at the canonical
Phase 1 location; only the new sibling at `crew-iterate/` needs
to be added. **Migration becomes a pure-add operation on Claude
— no relocation needed.**

## User reload verification

Run the setup script first:

```bash
./scripts/phase0-probes-setup.sh
```

Then verify the host-visible probes:

```bash
# Claude Code: start a fresh session, then inspect /skills.
claude
/skills
# Expected entries:
# /crew-iterate-spike-plugin:test-spike-one
# /crew-iterate-spike-plugin:test-spike-two
# /crew-iterate-spike-flat
# Probe 8: record whether both, one, or neither of these appear:
# /crew-iterate-spike-coex
# /crew-iterate-spike-coex:crew-iterate-spike-coex

# Codex: start a fresh session and inspect available skills.
codex
# Ask: "List available skills named crew-iterate-spike-flat or crew-iterate-spike-coex."
# Expected from source:
# crew-iterate-spike-flat
# two crew-iterate-spike-coex entries with different SKILL.md paths

# Gemini current install check, without writing spike files:
gemini
/skills list
# Expected from source/direct inspection:
# crew should NOT appear from ~/.gemini/extensions/crew/SKILL.md.
```

Cleanup after verification:

```bash
./scripts/phase0-probes-cleanup.sh
```

## Next steps for Phase 1 (revised 2026-05-16 post-empirical)

The empirical results force a **major plan simplification**:
sibling-flat personal-skills layout on ALL THREE hosts. Plugin
layouts are dropped from the plan.

**Revised install layout per host:**

| Host | Umbrella `crew` | Sub-skill `crew-iterate` | Frontmatter `name:` | Slash trigger |
| --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/skills/crew/SKILL.md` | `~/.claude/skills/crew-iterate/SKILL.md` | `crew` / `crew-iterate` | `/crew`, `/crew-iterate` |
| Codex | `~/.codex/skills/crew/SKILL.md` | `~/.codex/skills/crew-iterate/SKILL.md` | `crew` / `crew-iterate` | `crew`, `crew-iterate` |
| Gemini | `~/.gemini/skills/crew/SKILL.md` | `~/.gemini/skills/crew-iterate/SKILL.md` | `crew` / `crew-iterate` | `crew-iterate` |

**What this simplification eliminates from the plan:**

1. `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`
   writes — gone.
2. `PluginManifestSpec` type and the `pluginManifests` field on
   `SkillInstallSpec` — can be removed (or kept empty for
   future plugin-marketplace support).
3. The Claude umbrella SKILL.md "move from
   `~/.claude/skills/crew/SKILL.md` to
   `~/.claude/skills/crew/skills/crew/SKILL.md`" migration — not
   needed. The current v1 location IS the canonical path under
   sibling-flat.
4. Codex v1/v2 layout move — not needed. Current v1 location
   `~/.codex/skills/crew/SKILL.md` IS canonical.
5. Plugin manifest minimum-field probe — moot.
6. The cross-host trigger-name divergence note that contrasted
   `/crew:iterate` vs `crew:iterate` vs `crew-iterate` — now
   simpler: `/crew-iterate` vs `crew-iterate` vs `crew-iterate`,
   with Claude using the slash prefix and the others not.

**What remains in the plan:**

1. `SKILL_MANIFEST` with two entries (`crew` and `crew:iterate`).
2. `SkillInstallSpec` per host (path + frontmatter name +
   legacy paths to remove).
3. `verify` parity union across both skill files.
4. v1→v2 install-manifest schema bump tracking BOTH skill paths.
5. Gemini relocation from `~/.gemini/extensions/crew/SKILL.md`
   (broken today, per probe 1) to `~/.gemini/skills/crew/SKILL.md`
   + add `~/.gemini/skills/crew-iterate/SKILL.md`.
6. Atomic writes + per-`home` install lock (POSIX flock).
7. `writtenPaths` tracking for thorough uninstall.

**What changes on the iterate skill body:**

- `name: crew-iterate` (not `crew:iterate`) on all three hosts —
  Claude's lack of colon-in-name personal skills aligns it with
  Gemini's existing constraint.
- Slash trigger note simplifies: "Claude: `/crew-iterate`;
  Codex/Gemini: `crew-iterate`."
- All previous discussion of "namespacing varies per host" can
  be condensed.

**Future work (V2+):** if Claude Code adds a sideload-able
plugin pathway, OR if crew migrates to a Claude Code marketplace
plugin distribution model, the plan can be revisited. For now,
sibling-flat is the canonical path.
