/**
 * Skill renderer — combines the canonical body with a per-host template
 * and the live tool list to produce the markdown that gets written into
 * the host CLI's skills/prompts directory.
 *
 * The canonical body (`skills/crew-captain.body.md`) is the orchestration
 * playbook — single source of truth, edited in the repo. Per-host
 * templates (`skills/targets/<host>.md.tmpl`) wrap it in host-specific
 * frontmatter and opening framing. The renderer interpolates four
 * placeholders:
 *
 *   {{BODY}}         — the canonical body
 *   {{TOOL_LIST}}    — the live tool list rendered from the catalog (so
 *                      `crew-mcp verify` can parity-check the rendered skill
 *                      against the MCP surface)
 *   {{DESCRIPTION}}  — Claude Code skill description (auto-match phrase)
 *   {{CREW_VERSION}} — package version, useful as a footer marker
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
 * Phrase tuned for Claude Code's skill auto-matcher. Triggers on intent
 * like "have <agent> review this" or "dispatch X to Y" — the phrasings
 * we want to load on. Keep concise; Claude's matcher weights the
 * description heavily.
 */
export const SKILL_DESCRIPTION =
  'Dispatch coding work to other AI agents (Claude, Codex, Gemini, local models) in worktree-isolated runs. Use when the user wants to have one agent review another, run parallel implementations, or delegate to a different model. Provides run_agent / continue_run / merge_run / discard_run / get_run_status verbs.';

export interface SkillTool {
  readonly name: string;
  readonly description: string;
}

export interface RenderSkillArgs {
  readonly templatePath: string;
  readonly tools: readonly SkillTool[];
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
 * Load the canonical body. Strips HTML comments (intended for repo
 * readers — provenance notes, editing rules — not for the host CLI's
 * context window) and trims trailing whitespace; the renderer adds a
 * single trailing newline.
 */
export async function loadCanonicalBody(packageRoot: string): Promise<string> {
  const path = join(packageRoot, 'skills', 'crew-captain.body.md');
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
 * Render a skill file from a template + the canonical body + the live
 * tool list. Returns the final markdown ready to be written to the host's
 * skills directory. Does NOT write the file (that's the install command's
 * job).
 */
export async function renderSkill(args: RenderSkillArgs): Promise<string> {
  const packageRoot = resolvePackageRoot(args.packageRoot);
  const body = await loadCanonicalBody(packageRoot);
  const templateRaw = await readFile(args.templatePath, 'utf-8');

  const toolList = renderToolList(args.tools);
  const bodyWithTools = body.replace('{{TOOL_LIST}}', toolList);

  const rendered = templateRaw
    .replace('{{BODY}}', bodyWithTools)
    .replace(/\{\{DESCRIPTION\}\}/g, SKILL_DESCRIPTION)
    .replace(/\{\{CREW_VERSION\}\}/g, SERVE_VERSION);

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

/**
 * Resolve the full path to a per-host template file inside the package.
 * Templates live at `skills/targets/<id>.md.tmpl`.
 */
export function templatePathForHost(packageRoot: string, hostId: string): string {
  return join(packageRoot, 'skills', 'targets', `${hostId}.md.tmpl`);
}
