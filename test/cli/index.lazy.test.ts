import { afterEach, describe, expect, it, vi } from 'vitest';

describe('crew-mcp CLI lazy command imports', () => {
  afterEach(() => {
    vi.doUnmock('../../src/cli/commands/serve.js');
    vi.resetModules();
  });

  it('does not import the serve command module while rendering install help', async () => {
    vi.resetModules();
    let serveImported = false;
    vi.doMock('../../src/cli/commands/serve.js', () => {
      serveImported = true;
      return { serveCommand: vi.fn() };
    });

    const { buildProgram } = await import('../../src/index.js');
    const program = buildProgram();
    program.exitOverride();
    const quietOutput = {
      writeOut: () => undefined,
      writeErr: () => undefined,
    };
    program.configureOutput(quietOutput);
    for (const command of program.commands) {
      command.configureOutput(quietOutput);
    }

    await expect(
      program.parseAsync(['node', 'crew-mcp', 'install', '--help']),
    ).rejects.toThrow(/process\.exit unexpectedly called/);
    expect(serveImported).toBe(false);
  });
});
