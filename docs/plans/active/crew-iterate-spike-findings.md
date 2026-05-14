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
