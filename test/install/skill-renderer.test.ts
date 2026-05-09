/**
 * Skill renderer tests — placeholder substitution + tool list rendering.
 *
 * Uses the real canonical body and per-host templates from skills/ in
 * the repo (no mocking). Exercises the same code path `crew-mcp install`
 * uses, just without filesystem writes.
 */

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  renderSkill,
  renderToolList,
  resolvePackageRoot,
  stripHtmlComments,
  templatePathForHost,
  SKILL_DESCRIPTION,
  type SkillTool,
} from '../../src/install/skill-renderer.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(here, '..', '..');

const TOOLS: SkillTool[] = [
  { name: 'list_agents', description: 'list agents.' },
  { name: 'run_agent', description: 'dispatch a fresh run.' },
  { name: 'continue_run', description: 'resume a run.' },
  { name: 'merge_run', description: 'merge a run.' },
  { name: 'discard_run', description: 'abandon a run.' },
  { name: 'get_run_status', description: 'poll a run.' },
];

describe('renderToolList', () => {
  it('renders an empty list with a no-tools marker', () => {
    expect(renderToolList([])).toBe('_(no tools registered)_');
  });

  it('renders one bullet per tool with the mcp__crew__ prefix', () => {
    const out = renderToolList(TOOLS.slice(0, 2));
    expect(out).toBe(
      '- `mcp__crew__list_agents` — list agents.\n' +
        '- `mcp__crew__run_agent` — dispatch a fresh run.',
    );
  });
});

describe('resolvePackageRoot', () => {
  it('returns override verbatim when provided', () => {
    expect(resolvePackageRoot('/some/where')).toBe('/some/where');
  });

  it('locates the repo root from this test file', () => {
    // Default behaviour — walk up from src/install/skill-renderer.* until
    // skills/crew-captain.body.md is found.
    const root = resolvePackageRoot();
    expect(root).toBe(REPO_ROOT);
  });
});

describe('stripHtmlComments', () => {
  it('removes single-line comments', () => {
    expect(stripHtmlComments('a <!-- nope --> b')).toBe('a  b');
  });

  it('removes multi-line comments and squeezes 3+ newlines to a paragraph break', () => {
    const input = 'before\n\n<!--\n  meta\n  doc\n-->\n\nafter';
    expect(stripHtmlComments(input)).toBe('before\n\nafter');
  });

  it('removes a leading top-of-file comment block cleanly', () => {
    const input = '<!--\n  provenance\n-->\n\n## Heading\n';
    expect(stripHtmlComments(input)).toBe('## Heading\n');
  });

  it('leaves text without comments unchanged', () => {
    expect(stripHtmlComments('# Hello\nworld\n')).toBe('# Hello\nworld\n');
  });
});

describe('renderSkill (claude-code template)', () => {
  it('substitutes BODY, TOOL_LIST, and DESCRIPTION', async () => {
    const templatePath = templatePathForHost(REPO_ROOT, 'claude-code');
    const out = await renderSkill({
      templatePath,
      tools: TOOLS,
      packageRoot: REPO_ROOT,
    });

    // Frontmatter
    expect(out).toMatch(/^---\nname: crew\ndescription: /);
    expect(out).toContain(SKILL_DESCRIPTION);

    // Body content shows up
    expect(out).toContain('## Crew — orchestration playbook');
    expect(out).toContain('## Escape hatch');
    expect(out).toContain('## Dispatch-vs-inline');
    expect(out).toContain('## Merge boundary');
    expect(out).toContain('wait_for_terminal_only: true');
    expect(out).toContain('timed_out: true');

    // Tool list rendered
    for (const tool of TOOLS) {
      expect(out).toContain(`mcp__crew__${tool.name}`);
    }

    // No leftover placeholders
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);

    // No HTML comments leaked from the canonical body — those are
    // repo-reader provenance notes that shouldn't ship in the rendered
    // skill (Finding 2 from docs/status/v0.2-smoke-2026-05-04.md).
    expect(out).not.toContain('<!--');
    expect(out).not.toContain('-->');
  });

  it('ends with exactly one trailing newline', async () => {
    const templatePath = templatePathForHost(REPO_ROOT, 'claude-code');
    const out = await renderSkill({
      templatePath,
      tools: TOOLS,
      packageRoot: REPO_ROOT,
    });
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });
});

describe('renderSkill (codex template)', () => {
  it('emits SKILL.md frontmatter with name + description (Finding 5 fix)', async () => {
    const templatePath = templatePathForHost(REPO_ROOT, 'codex');
    const out = await renderSkill({
      templatePath,
      tools: TOOLS,
      packageRoot: REPO_ROOT,
    });

    // Codex 0.128.0 auto-loads skills from ~/.codex/skills/<name>/SKILL.md
    // with frontmatter — same convention as Claude Code. Pre-fix template
    // had no frontmatter and lived at ~/.codex/prompts/, which Codex never
    // discovered as a skill.
    expect(out).toMatch(/^---\nname: crew\ndescription: /);
    expect(out).toContain(SKILL_DESCRIPTION);
    expect(out).toContain('## Crew — orchestration playbook');
    expect(out).toContain('mcp__crew__run_agent');
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});

describe('renderSkill (gemini template)', () => {
  it('substitutes BODY but uses no frontmatter', async () => {
    const templatePath = templatePathForHost(REPO_ROOT, 'gemini');
    const out = await renderSkill({
      templatePath,
      tools: TOOLS,
      packageRoot: REPO_ROOT,
    });

    expect(out).not.toMatch(/^---/);
    expect(out).toContain('# crew — orchestration playbook');
    expect(out).toContain('Loaded as a Gemini extension');
    expect(out).toContain('mcp__crew__merge_run');
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});
