import { describe, expect, it } from 'vitest';
import { buildClaudeStreamArgs } from '../../src/adapters/claude-code.js';

describe('buildClaudeStreamArgs + --mcp-config (M3-8)', () => {
  it('omits the flag when mcpConfigJson is undefined', () => {
    const args = buildClaudeStreamArgs({});
    expect(args).not.toContain('--mcp-config');
  });

  it('appends --mcp-config <inline-json> when supplied', () => {
    const config = '{"mcpServers":{"crew":{"command":"/bin/crew-mcp"}}}';
    const args = buildClaudeStreamArgs({ mcpConfigJson: config });
    const idx = args.indexOf('--mcp-config');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe(config);
  });

  it('accepts the "{}" empty catalog serialization without crashing', () => {
    const args = buildClaudeStreamArgs({ mcpConfigJson: '{}' });
    expect(args).toContain('--mcp-config');
    expect(args).toContain('{}');
  });

  it('threads --resume and --mcp-config together on a resume call', () => {
    const args = buildClaudeStreamArgs({
      resumedSessionId: 'sess-abc',
      mcpConfigJson: '{"mcpServers":{}}',
    });
    expect(args).toContain('--resume');
    expect(args).toContain('sess-abc');
    expect(args).toContain('--mcp-config');
  });

  it('the stream-json flags come before --resume and --mcp-config', () => {
    const args = buildClaudeStreamArgs({
      resumedSessionId: 'sess-abc',
      mcpConfigJson: '{}',
    });
    // `-p --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions`
    // appear before --resume and --mcp-config. Assert order by index.
    expect(args.indexOf('-p')).toBe(0);
    const streamIdx = args.indexOf('--output-format');
    expect(streamIdx).toBeGreaterThan(-1);
    expect(args.indexOf('--resume')).toBeGreaterThan(streamIdx);
    expect(args.indexOf('--mcp-config')).toBeGreaterThan(streamIdx);
  });
});
