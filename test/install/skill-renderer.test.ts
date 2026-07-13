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
import { parse as parseYaml } from 'yaml';

import {
  captainSkillTools,
  ITERATE_SKILL_DESCRIPTION,
  renderSkill,
  renderToolList,
  resolvePackageRoot,
  SKILL_MANIFEST,
  stripHtmlComments,
  templatePathForHost,
  SKILL_DESCRIPTION,
  type SkillManifestEntry,
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

describe('captainSkillTools', () => {
  it('excludes worker-only tools from captain-rendered skill surfaces', () => {
    expect(captainSkillTools([
      ...TOOLS,
      { name: 'send_message', description: 'worker report.', mode: 'worker' },
      { name: 'shared_tool', description: 'shared.', mode: 'both' },
    ]).map((tool) => tool.name)).toEqual([
      'list_agents',
      'run_agent',
      'continue_run',
      'merge_run',
      'discard_run',
      'get_run_status',
      'shared_tool',
    ]);
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
      tools: [
        ...TOOLS,
        { name: 'send_message', description: 'worker report.', mode: 'worker' },
      ],
      packageRoot: REPO_ROOT,
    });

    // Frontmatter
    expect(out).toMatch(/^---\nname: crew\ndescription: /);
    expect(out).toContain(SKILL_DESCRIPTION);

    // Body content shows up
    expect(out).toContain('## Crew orchestration playbook');
    expect(out).toContain('## Tool availability');
    expect(out).toContain('## Dispatch or inline');
    expect(out).toContain('## Merge boundary');
    expect(out).toContain('## Dispatch lifecycle');
    expect(out).toContain('Step 2 - background watcher overlay (Claude Code and Codex, mandatory)');
    expect(out).toContain('Checking pending runs at turn start');
    expect(out).not.toContain('## Polling lifecycle — every dispatch');
    expect(out).not.toContain('Hard rule: stay in the same turn');

    // Tool list rendered
    for (const tool of TOOLS) {
      expect(out).toContain(`mcp__crew__${tool.name}`);
    }
    expect(out).not.toContain('mcp__crew__send_message');

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

  it('substitutes {{CREW_WAIT_COMMAND}} (default: bare name)', async () => {
    const templatePath = templatePathForHost(REPO_ROOT, 'claude-code');
    const out = await renderSkill({
      templatePath,
      tools: TOOLS,
      packageRoot: REPO_ROOT,
    });

    // The install command remains documented as a template value, while
    // dispatch-time watcher launches use the server-returned command so its
    // Crew-home pin and run ids cannot drift.
    expect(out.replace(/\s+/g, ' ')).toContain('rendered `crew-wait` template');
    expect(out).toContain('Bash(<required_next_action.command>, run_in_background: true)');
    expect(out).not.toMatch(/\{\{CREW_WAIT_COMMAND\}\}/);
  });

  it('substitutes {{CREW_WAIT_COMMAND}} with absolute path when install fell back', async () => {
    // Regression: skill-prose / allowlist-entry coupling. If
    // install used `Bash(/usr/local/bin/crew-wait:*)`, the skill body
    // MUST instruct captains to use the same absolute form — bare
    // `crew-wait` would not pass the matcher.
    const templatePath = templatePathForHost(REPO_ROOT, 'claude-code');
    const ABSOLUTE_PATH = '/usr/local/bin/crew-wait';
    const out = await renderSkill({
      templatePath,
      tools: TOOLS,
      crewWaitCommand: ABSOLUTE_PATH,
      packageRoot: REPO_ROOT,
    });

    expect(out.replace(/\s+/g, ' ')).toContain(`rendered \`${ABSOLUTE_PATH}\` template`);
    expect(out).not.toMatch(/\{\{CREW_WAIT_COMMAND\}\}/);
    // Bare "crew-wait" can still appear in prose, but the actual
    // command-shape examples must use the absolute path.
    expect(out).toContain('Bash(<required_next_action.command>, run_in_background: true)');
  });

  it('renders the Phase 2 dispatch-and-yield body (Remove / Replace / Add bullets)', async () => {
    // Targeted assertions for the Phase 2 skill rewrite per
    // docs/plans/active/non-blocking-captain.md. These guard against
    // future drift: removing a section the plan removed, restoring
    // language the plan rejected, or losing the new guidance.
    const templatePath = templatePathForHost(REPO_ROOT, 'claude-code');
    const out = await renderSkill({
      templatePath,
      tools: TOOLS,
      packageRoot: REPO_ROOT,
    });

    // REMOVED — must not reappear:
    expect(out).not.toContain('## Polling lifecycle — every dispatch');
    expect(out).not.toContain('Hard rule: stay in the same turn');
    // The plan deprecated "Always pass wait_for_change_ms: 30000" as
    // the captain default.
    expect(out).not.toMatch(/Always pass\s+`wait_for_change_ms:\s*30000`/);

    // ADDED — Phase 2 + post-review revisions:
    expect(out).toContain('Step 2 - background watcher overlay (Claude Code and Codex, mandatory)');
    expect(out).toContain('CREW_WAIT_TERMINAL run_id=');
    expect(out).toContain('Completion-event handling');
    expect(out).toContain('await yield_control()');
    expect(out).toContain('notify(JSON.stringify({');
    expect(out).toContain('tools.write_stdin({');
    expect(out).toContain('required_next_action.command_json');
    expect(out).toContain('required_next_action.run_ids_json');
    expect(out).toContain('required_next_action.working_directory_json');
    expect(out).toContain('workdir,');
    expect(out).toContain('output.slice(-overlap)');
    expect(out).toContain('chunk.slice(0, overlap)');
    expect(out).toContain("type: 'crew_wait_failed'");
    expect(out).toContain("result.session_id !== undefined && result.exit_code === undefined");
    expect(out).toContain("output.includes('CREW_WAIT_TERMINAL ')");
    expect(out).toContain('do **not** call `wait`');
    expect(out).toContain('list_runs');
    // Foreground waiting remains forbidden on Codex; only the deferred
    // yield-before-wait recipe is allowed.
    expect(out).toContain('Do not use a foreground watcher on Codex');
    expect(out).toContain('deferred Step 2 recipe');
    expect(out).not.toContain('docs/status/captain-flow-review-2026-04-29.md');
    expect(out).toContain('panel-level');
    expect(out).toContain('commits');
    expect(out).toContain('commit_count');
    // Multiple terminations don't batch:
    expect(out).toContain("don't batch");
    // Pending-run check guidance:
    expect(out).toContain('Checking pending runs at turn start');
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
    expect(out).toContain('## Crew orchestration playbook');
    expect(out).toContain('mcp__crew__run_agent');
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});

describe('renderSkill frontmatter — YAML parses cleanly (regression guard)', () => {
  // The description string contains colon-space sequences ("TRIGGER
  // when the user: asks...") that break unquoted YAML scalars. The
  // template MUST emit the description as a block/quoted scalar so the
  // installed SKILL.md parses without `mapping values are not allowed`
  // errors at host CLI load time. This test parses the rendered
  // frontmatter and asserts the round-tripped value matches the
  // source constant byte-for-byte.

  function parseFrontmatter(rendered: string): Record<string, unknown> {
    const match = rendered.match(/^---\n([\s\S]*?)\n---/);
    if (!match) throw new Error('no frontmatter block found');
    return parseYaml(match[1]) as Record<string, unknown>;
  }

  it.each(['claude-code', 'codex', 'agy'] as const)(
    '%s template renders description as a YAML scalar matching SKILL_DESCRIPTION',
    async (host) => {
      const templatePath = templatePathForHost(REPO_ROOT, host);
      const out = await renderSkill({
        templatePath,
        tools: TOOLS,
        packageRoot: REPO_ROOT,
      });
      const fm = parseFrontmatter(out);
      expect(fm.name).toBe('crew');
      expect(fm.description).toBe(SKILL_DESCRIPTION);
    },
  );

  it.each(['claude-code', 'codex', 'agy'] as const)(
    '%s template renders crew-iterate description matching ITERATE_SKILL_DESCRIPTION',
    async (host) => {
      const iterate = SKILL_MANIFEST.find((s) => s.id === 'crew:iterate')!;
      const templatePath = templatePathForHost(REPO_ROOT, host);
      const out = await renderSkill({
        templatePath,
        skill: iterate,
        spec: {
          skillPath: '/tmp/ignored',
          frontmatterName: 'crew-iterate',
          legacyPathsToRemove: [],
        },
        tools: TOOLS,
        packageRoot: REPO_ROOT,
      });
      const fm = parseFrontmatter(out);
      expect(fm.name).toBe('crew-iterate');
      expect(fm.description).toBe(ITERATE_SKILL_DESCRIPTION);
    },
  );
});

describe('SKILL_MANIFEST', () => {
  it('has unique skill ids and unique slugs', () => {
    const ids = new Set<string>();
    const slugs = new Set<string>();
    for (const entry of SKILL_MANIFEST) {
      expect(ids.has(entry.id)).toBe(false);
      expect(slugs.has(entry.slug)).toBe(false);
      ids.add(entry.id);
      slugs.add(entry.slug);
    }
  });

  it('has umbrella `crew` entry first (slug `crew`, body crew-captain.body.md)', () => {
    const [umbrella] = SKILL_MANIFEST;
    expect(umbrella.id).toBe('crew');
    expect(umbrella.slug).toBe('crew');
    expect(umbrella.bodyFile).toBe('crew-captain.body.md');
    expect(umbrella.description).toBe(SKILL_DESCRIPTION);
  });

  it('has a `crew:iterate` entry with body crew-iterate.body.md', () => {
    const iterate = SKILL_MANIFEST.find((s) => s.id === 'crew:iterate');
    expect(iterate).toBeDefined();
    expect(iterate?.slug).toBe('iterate');
    expect(iterate?.bodyFile).toBe('crew-iterate.body.md');
    expect(iterate?.description).toBe(ITERATE_SKILL_DESCRIPTION);
  });

  it('every entry has non-empty fields', () => {
    for (const entry of SKILL_MANIFEST) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.slug.length).toBeGreaterThan(0);
      expect(entry.bodyFile.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(20);
    }
  });

  // Claude Code rejects skill descriptions over 1024 characters, and the
  // `description: |-` block scalar in the host templates only indents a
  // single substituted line — a newline in the constant would produce
  // invalid YAML frontmatter.
  it('every description fits the 1024-char host cap on a single line', () => {
    for (const entry of SKILL_MANIFEST) {
      expect(entry.description.length).toBeLessThanOrEqual(1024);
      expect(entry.description).not.toContain('\n');
    }
  });
});

describe('renderSkill (crew:iterate skill)', () => {
  const ITERATE_ENTRY = SKILL_MANIFEST.find((s) => s.id === 'crew:iterate')!;

  it('renders the iterate body via the claude-code template', async () => {
    const templatePath = templatePathForHost(REPO_ROOT, 'claude-code');
    const spec = {
      skillPath: '/tmp/ignored',
      frontmatterName: 'crew-iterate',
      legacyPathsToRemove: [],
    };
    const out = await renderSkill({
      templatePath,
      skill: ITERATE_ENTRY,
      spec,
      tools: TOOLS,
      packageRoot: REPO_ROOT,
    });

    expect(out).toMatch(/^---\nname: crew-iterate\ndescription: /);
    expect(out).toContain(ITERATE_SKILL_DESCRIPTION);
    expect(out).toContain('iterate-to-acceptance playbook');
    expect(out).toContain('acceptance criteria');
    expect(out).toContain('Step 0');
    // Tool list still substitutes.
    expect(out).toContain('mcp__crew__run_agent');
    // No placeholders left over.
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('honors per-host frontmatter name from spec', async () => {
    const templatePath = templatePathForHost(REPO_ROOT, 'codex');
    const spec: SkillManifestEntry & { frontmatterName: string } = {
      ...ITERATE_ENTRY,
      frontmatterName: 'crew-iterate',
    };
    const out = await renderSkill({
      templatePath,
      skill: ITERATE_ENTRY,
      spec: {
        skillPath: '/tmp/ignored',
        frontmatterName: spec.frontmatterName,
        legacyPathsToRemove: [],
      },
      tools: TOOLS,
      packageRoot: REPO_ROOT,
    });

    expect(out).toMatch(/^---\nname: crew-iterate\n/);
  });

  it('defaults frontmatter name to skill slug when spec is omitted', async () => {
    const templatePath = templatePathForHost(REPO_ROOT, 'claude-code');
    const out = await renderSkill({
      templatePath,
      skill: ITERATE_ENTRY,
      tools: TOOLS,
      packageRoot: REPO_ROOT,
    });

    // Default falls back to skill.slug ("iterate").
    expect(out).toMatch(/^---\nname: iterate\n/);
  });
});
