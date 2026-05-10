import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatClaudeStreamLineForStream } from '../../src/adapters/claude-code.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf-8');
}

function fixtureLines(name: string): string[] {
  return loadFixture(name)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

describe('claude-code stream parser', () => {
  it('formats the Claude Code 2.1.131 stream fixture into semantic lines', () => {
    const lines = fixtureLines('claude-stream-2.1.131.jsonl')
      .flatMap((line) => formatClaudeStreamLineForStream(line));

    expect(lines).toEqual([
      expect.stringMatching(/^system: init claude-opus-4-7\[1m\] tools=\d+ mcp=5\/9$/),
      'system: rate-limit allowed five_hour',
      'thinking: thinking',
      expect.stringMatching(/^tool: Read\(\{"file_path":"\/Users\/chasen\/\.crew\/runs\/.*\/README\.md"\}\)$/),
      'result: ok',
      expect.stringContaining('message: - MCP server that turns any AI coding CLI'),
      'turn: completed',
    ]);
  });

  it('walks assistant content blocks and emits one line per semantic block', () => {
    const lines = formatClaudeStreamLineForStream(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'Checking the repo shape.' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } },
          { type: 'text', text: 'Done.' },
        ],
      },
    }));

    expect(lines).toEqual([
      'thinking: Checking the repo shape.',
      'tool: Read({"file_path":"README.md"})',
      'message: Done.',
    ]);
  });

  it('walks user content blocks for nested tool results and skips pure text echoes', () => {
    const lines = formatClaudeStreamLineForStream(JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'text', text: 'echoed prompt' },
          { type: 'tool_result', content: 'ok' },
          { type: 'tool_result', is_error: true, content: 'failed' },
        ],
      },
    }));

    expect(lines).toEqual([
      'result: ok',
      'result: error',
    ]);
  });

  it('formats system, rate-limit, and terminal result events', () => {
    expect(formatClaudeStreamLineForStream(JSON.stringify({
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-7',
      tools: ['Read', 'Edit'],
      mcp_servers: [
        { name: 'crew', status: 'connected' },
        { name: 'drive', status: 'needs-auth' },
      ],
    }))).toEqual([
      'system: init claude-sonnet-4-7 tools=2 mcp=1/2',
    ]);

    expect(formatClaudeStreamLineForStream(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' },
    }))).toEqual([
      'system: rate-limit allowed five_hour',
    ]);

    expect(formatClaudeStreamLineForStream(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
    }))).toEqual(['turn: completed']);

    expect(formatClaudeStreamLineForStream(JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      terminal_reason: 'permission denied',
    }))).toEqual(['turn: failed permission denied']);
  });

  it('emits bounded fallbacks for malformed, unknown, and unknown nested events', () => {
    expect(formatClaudeStreamLineForStream('not json')).toEqual([
      'event: unknown',
    ]);
    expect(formatClaudeStreamLineForStream(JSON.stringify({ type: 'mystery' }))).toEqual([
      'event: mystery',
    ]);
    expect(formatClaudeStreamLineForStream(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'image' }] },
    }))).toEqual([
      'event: assistant/image',
    ]);
  });

  it('bounds adapter progress lines to the runtime max without an agent prefix', () => {
    const [line] = formatClaudeStreamLineForStream(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'x'.repeat(1000) }],
      },
    }));

    expect(line).toMatch(/^message: /);
    expect(line.length).toBeLessThanOrEqual(240);
  });
});
