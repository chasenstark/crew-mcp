/**
 * Skill renderer — combines a per-skill canonical body with a per-host
 * template and the live tool list to produce the markdown that gets
 * written into the host CLI's skills/prompts directory.
 *
 * Two skills ship today (per `crew-iterate-skill.md` plan):
 *
 *   - `crew` (umbrella) — `skills/crew-captain.body.md`
 *   - `crew-iterate`    — `skills/crew-iterate.body.md`
 *
 * Both render through the same per-host templates; the template
 * placeholders that vary per-skill are `{{NAME}}` (frontmatter name)
 * and `{{DESCRIPTION}}` (the auto-match matcher phrase). `{{BODY}}` is
 * loaded from the skill's `bodyFile`. `{{TOOL_LIST}}` and
 * `{{CREW_WAIT_COMMAND}}` are shared across skills.
 *
 * Path resolution: `crew-mcp install` runs from the installed package, so we
 * resolve `skills/` relative to the source file's compiled location. The
 * built bundle's import.meta.url points into `dist/`, which sits as a
 * sibling of `skills/`. Tests can override via `packageRoot`.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SERVE_VERSION } from '../cli/commands/serve.js';

/**
 * Phrase tuned for Claude Code's skill auto-matcher. Uses the
 * TRIGGER/SKIP format (cf. the built-in `claude-api` skill) to widen
 * the net: enumerates supported model aliases the user is likely to
 * name (Claude/sonnet/opus, Codex, Gemini, local), task types beyond
 * coding (review, investigation, spec-writing, audits, spikes, triage),
 * project-specific vocabulary the user actually reaches for (crew,
 * panel, subagent, peer), dispatch verbs (have/ask/send to, kick off,
 * spawn, fan out, offload, hand off, delegate, race, fire off), and a
 * SKIP clause that sharpens the matcher by ruling out inline TaskCreate
 * dispatches and local shell commands. Worktree isolation is described
 * as the default rather than universal — read-only runs reuse the
 * current tree (`run_agent --read_only`). Loaded into every session's
 * context, so the byte cost is permanent — keep additions matcher-load-
 * bearing, not decorative. Hard budget: Claude Code rejects skill
 * descriptions over 1024 characters, and the YAML block scalar in the
 * host templates requires a single line — both enforced by tests.
 */
export const SKILL_DESCRIPTION =
  'Dispatch work to another AI agent (Claude, Codex, Gemini, agy/Antigravity, GPT, sonnet, opus, local models) — coding, code review, investigations, spec-writing, refactors, audits, drafts, prototypes, spikes, triage. Isolated git worktree by default; read-only for review/triage. TRIGGER when the user: asks another model or agent (by name or generically) to do, review, critique, investigate, audit, draft, prototype, sanity-check, or double-check work; wants a second opinion, second pair of eyes, cross-model comparison, panel of agents, or crew run; says "have/ask/send to/run it by/use <model>", "what does <model> think", "get <model>\'s take", "another Claude/Codex/Gemini", "subagent", "peer", "crew", "panel", "in parallel", "in the background", "while I…", "offload", "hand off", "delegate", "fan out", "kick off", "spawn", "fire off", or "race"; or wants long-running work that doesn\'t block the chat. SKIP when the user wants an inline subagent (TaskCreate) or a local shell command.';

/**
 * Auto-match phrase for the `crew-iterate` skill. Distinct from
 * SKILL_DESCRIPTION so Claude Code's matcher routes "ship-quality"
 * loops here rather than the umbrella `crew` dispatch skill. Keep the
 * vocabulary narrow to "keep iterating until acceptance criteria pass"
 * to avoid poaching one-shot dispatches.
 */
export const ITERATE_SKILL_DESCRIPTION =
  'Keep iterating on an implementation until acceptance criteria pass and reviewers approve. Loads when the user wants to ship-quality something via a multi-agent implement-review loop — phrasings like "keep working on X with review", "implement X and review until it\'s good", "iterate to convergence", "keep going until tests/criteria pass", "loop until reviewers approve", "don\'t stop until it\'s done", "ship-quality loop", "review loop", "polish until it ships", "use Claude + Codex to push this until criteria pass". The captain derives acceptance criteria, confirms with the user, dispatches an implementer with criteria embedded, runs crew + host-native review scoring per criterion, and folds findings back via continue_run until every criterion is PASS and every reviewer\'s verdict is APPROVE. Composes run_agent, continue_run, run_panel, aggregate_panel, merge_run.';

export interface SkillTool {
  readonly name: string;
  readonly description: string;
  readonly mode?: 'captain' | 'worker' | 'both';
}

/**
 * One entry in the canonical SKILL_MANIFEST. The install command loops
 * over the manifest and writes one rendered SKILL.md per entry.
 */
export interface SkillManifestEntry {
  /** Skill ID, including namespace. `crew` for the umbrella, `crew:iterate` for the sub-skill. */
  readonly id: string;
  /**
   * Bare slug after the namespace prefix. Used by adapters to compute
   * the on-disk path and the frontmatter `name:` value.
   * - `crew` → slug `crew`
   * - `crew:iterate` → slug `iterate`
   */
  readonly slug: string;
  /** Path (relative to packageRoot/skills/) to the body file. */
  readonly bodyFile: string;
  /** Description string for the host matcher. */
  readonly description: string;
}

/**
 * The canonical list of skills crew installs. Order matters for
 * deterministic test output and for predictable install logging, but
 * each entry is independent.
 */
export const SKILL_MANIFEST: readonly SkillManifestEntry[] = [
  {
    id: 'crew',
    slug: 'crew',
    bodyFile: 'crew-captain.body.md',
    description: SKILL_DESCRIPTION,
  },
  {
    id: 'crew:iterate',
    slug: 'iterate',
    bodyFile: 'crew-iterate.body.md',
    description: ITERATE_SKILL_DESCRIPTION,
  },
];

/**
 * Per-host install spec returned by `HostAdapter.skillInstallSpecFor`.
 * Tells the install command WHERE to write the rendered SKILL.md and
 * what frontmatter `name:` to bake into it.
 */
export interface SkillInstallSpec {
  /** Final on-disk path for the rendered SKILL.md. */
  readonly skillPath: string;
  /** Literal value written to the frontmatter `name:` field. */
  readonly frontmatterName: string;
  /**
   * Legacy paths the install must remove (v1 SKILL.md locations).
   * Empty for Claude/Codex (their current v1 paths ARE canonical);
   * populated for Gemini (relocates from `~/.gemini/extensions/crew/SKILL.md`
   * to `~/.gemini/skills/crew/SKILL.md`).
   */
  readonly legacyPathsToRemove: readonly string[];
  /**
   * When true, the install renders nothing to `skillPath` for this
   * host — it only processes `legacyPathsToRemove`. Used when the host
   * already discovers the skill from a shared location on its search
   * path (e.g. Gemini natively scans `~/.agents/skills/`, which Claude
   * Code populates), so a per-host copy would be a duplicate the host
   * warns about. The skipped skill is excluded from the install
   * manifest's written-paths and skills map.
   */
  readonly skip?: boolean;
}

export interface RenderSkillArgs {
  readonly templatePath: string;
  /**
   * Manifest entry being rendered. Determines which `bodyFile` to load
   * and which `description` to substitute. Optional for back-compat:
   * if omitted, defaults to the umbrella `crew` entry (SKILL_MANIFEST[0]).
   */
  readonly skill?: SkillManifestEntry;
  /**
   * Per-host install spec computed by the adapter. Provides the
   * frontmatter `name:` value. Optional for back-compat: if omitted,
   * the frontmatter name defaults to the skill's slug.
   */
  readonly spec?: SkillInstallSpec;
  readonly tools: readonly SkillTool[];
  /**
   * Literal `Bash` invocation the captain should use to spawn the
   * watcher. Substituted into `{{CREW_WAIT_COMMAND}}` placeholders in
   * the body. Must match the host's allowlist entry exactly — bare
   * `crew-wait` when the install detected it on PATH, or an absolute
   * path like `/usr/local/bin/crew-wait` when install used the
   * absolute-path fallback. Hosts that don't run the watcher (Codex,
   * Gemini) still receive the literal so the prose reads sensibly,
   * but they default to the portable baseline anyway.
   */
  readonly crewWaitCommand?: string;
  /**
   * Override for tests. Defaults to a path resolved relative to this
   * file's compiled location (which sits in dist/install/ at runtime,
   * with skills/ as a sibling of dist/).
   */
  readonly packageRoot?: string;
}

/**
 * Resolve the package root that contains `skills/`. Tries (in order):
 *   1. The override passed in (test seam).
 *   2. Walking up from this file's location until we find `skills/`.
 * Throws if neither finds it — the install can't proceed without the
 * canonical body.
 */
export function resolvePackageRoot(override?: string): string {
  if (override) return override;
  // import.meta.url at runtime points into dist/install/skill-renderer.js
  // (or src/install/skill-renderer.ts under tests with vitest-tsconfig).
  const here = dirname(fileURLToPath(import.meta.url));
  // Walk up: dist/install/skill-renderer.js -> dist/install -> dist -> root.
  // Or src/install/skill-renderer.ts -> src/install -> src -> root.
  let cursor = here;
  for (let i = 0; i < 6; i++) {
    const candidate = join(cursor, 'skills', 'crew-captain.body.md');
    if (existsSync(candidate)) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(
    `Could not locate skills/ relative to ${here}. Pass packageRoot explicitly.`,
  );
}

/**
 * Load a skill body file by name (relative to `<packageRoot>/skills/`).
 * Strips HTML comments (intended for repo readers — provenance notes,
 * editing rules — not for the host CLI's context window) and trims
 * trailing whitespace; the renderer adds a single trailing newline.
 */
export async function loadSkillBody(
  packageRoot: string,
  bodyFile: string,
): Promise<string> {
  const path = join(packageRoot, 'skills', bodyFile);
  const raw = await readFile(path, 'utf-8');
  return stripHtmlComments(raw).trimEnd();
}

/**
 * Strip `<!-- ... -->` blocks (including multi-line) from markdown.
 * Used to keep meta-documentation in the body source out of the
 * rendered skill that ships into the host CLI's context. Squeezes
 * the resulting blank-line gap so the output doesn't carry a hole
 * where the comment used to be.
 */
export function stripHtmlComments(input: string): string {
  return input
    .replace(/<!--[\s\S]*?-->/g, '')
    // The comment block is typically on its own line(s); after removal,
    // any chain of 3+ consecutive newlines collapses to 2 so the
    // markdown stays well-formed.
    .replace(/\n{3,}/g, '\n\n')
    // If the comment was at the very top, leading blank lines can hang
    // around. Trim them.
    .replace(/^\s*\n+/, '');
}

/**
 * Render a skill file from a template + the skill's body + the live
 * tool list. Returns the final markdown ready to be written to the host's
 * skills directory. Does NOT write the file (that's the install command's
 * job).
 *
 * Substitutions:
 *   {{BODY}}              — the skill's body (loaded from `skill.bodyFile`)
 *   {{NAME}}              — `spec.frontmatterName` (defaults to `skill.slug`)
 *   {{DESCRIPTION}}       — `skill.description`
 *   {{CREW_VERSION}}      — package version
 *   {{CREW_WAIT_COMMAND}} — `crewWaitCommand`
 *   {{TOOL_LIST}}         — rendered tool catalog (substituted into the body)
 */
export async function renderSkill(args: RenderSkillArgs): Promise<string> {
  const packageRoot = resolvePackageRoot(args.packageRoot);
  const skill = args.skill ?? SKILL_MANIFEST[0];
  const body = await loadSkillBody(packageRoot, skill.bodyFile);
  const templateRaw = await readFile(args.templatePath, 'utf-8');

  const toolList = renderToolList(captainSkillTools(args.tools));
  const crewWaitCommand = args.crewWaitCommand ?? 'crew-wait';
  const bodyWithTools = body
    .replace('{{TOOL_LIST}}', toolList)
    .replace(/\{\{CREW_WAIT_COMMAND\}\}/g, crewWaitCommand);

  const frontmatterName = args.spec?.frontmatterName ?? skill.slug;

  const rendered = templateRaw
    .replace('{{BODY}}', bodyWithTools)
    .replace(/\{\{NAME\}\}/g, frontmatterName)
    .replace(/\{\{DESCRIPTION\}\}/g, skill.description)
    .replace(/\{\{CREW_VERSION\}\}/g, SERVE_VERSION)
    .replace(/\{\{CREW_WAIT_COMMAND\}\}/g, crewWaitCommand);

  return rendered.trimEnd() + '\n';
}

/**
 * Render the tool catalog as a markdown bullet list. The format is
 * stable so `crew-mcp verify` can parse `mcp__crew__*` references back out:
 *
 *   - `mcp__crew__<name>` — <description>
 */
export function renderToolList(tools: readonly SkillTool[]): string {
  if (tools.length === 0) return '_(no tools registered)_';
  return tools
    .map((t) => `- \`mcp__crew__${t.name}\` — ${t.description}`)
    .join('\n');
}

export function captainSkillTools(tools: readonly SkillTool[]): readonly SkillTool[] {
  return tools.filter((tool) => tool.mode === undefined || tool.mode === 'captain' || tool.mode === 'both');
}

/**
 * Resolve the full path to a per-host template file inside the package.
 * Templates live at `skills/targets/<id>.md.tmpl`.
 */
export function templatePathForHost(packageRoot: string, hostId: string): string {
  return join(packageRoot, 'skills', 'targets', `${hostId}.md.tmpl`);
}
