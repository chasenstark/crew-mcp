import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../../src/workflow/config-codec.js';
import {
  configPathHelpLines,
  resolveConfigPath,
  SUPPORTED_CONFIG_SET_PATHS,
} from '../../src/workflow/config-path-registry.js';

describe('config path registry', () => {
  it('exposes the supported set paths list', () => {
    expect(SUPPORTED_CONFIG_SET_PATHS).toEqual([
      'workflow.agentDefaults.iterate.implementer',
      'workflow.agentDefaults.iterate.reviewers',
      'workflow.agentDefaults.iterate.banList',
      'workflow.agentDefaults.panel.reviewers',
      'workflow.agentDefaults.panel.banList',
    ]);
  });

  it('provides an example line for every descriptor', () => {
    expect(configPathHelpLines()).toHaveLength(SUPPORTED_CONFIG_SET_PATHS.length);
    for (const line of configPathHelpLines()) {
      expect(line).toMatch(/^\/config set workflow\.agentDefaults\./);
    }
  });

  describe('workflow.agentDefaults', () => {
    it('parses + writes iterate implementer and reviewer lists', () => {
      const config = getDefaultConfig();
      const implementer = resolveConfigPath('workflow.agentDefaults.iterate.implementer');
      const reviewers = resolveConfigPath('workflow.agentDefaults.iterate.reviewers');
      expect(implementer).not.toBeNull();
      expect(reviewers).not.toBeNull();

      const parsedImplementer = implementer!.descriptor.parse(
        'codex',
        config,
        implementer!.params,
        'workflow.agentDefaults.iterate.implementer',
      );
      implementer!.descriptor.write(
        config,
        implementer!.params,
        parsedImplementer,
        'workflow.agentDefaults.iterate.implementer',
      );
      const parsedReviewers = reviewers!.descriptor.parse(
        '["claude-code"]',
        config,
        reviewers!.params,
        'workflow.agentDefaults.iterate.reviewers',
      );
      reviewers!.descriptor.write(
        config,
        reviewers!.params,
        parsedReviewers,
        'workflow.agentDefaults.iterate.reviewers',
      );

      expect(config.workflow.agentDefaults?.iterate).toEqual({
        implementer: 'codex',
        reviewers: ['claude-code'],
      });
    });

    it('rejects empty strings in agent default lists', () => {
      const config = getDefaultConfig();
      const resolved = resolveConfigPath('workflow.agentDefaults.panel.reviewers');
      expect(() =>
        resolved!.descriptor.parse(
          '[""]',
          config,
          resolved!.params,
          'workflow.agentDefaults.panel.reviewers',
        ),
      ).toThrow(/non-empty strings/);
    });

    it('accepts comma-delimited lists and [] to clear', () => {
      const config = getDefaultConfig();
      const resolved = resolveConfigPath('workflow.agentDefaults.panel.reviewers');
      expect(resolved!.descriptor.parse(
        'codex, claude-code',
        config,
        resolved!.params,
        'workflow.agentDefaults.panel.reviewers',
      )).toEqual(['codex', 'claude-code']);
      expect(resolved!.descriptor.parse(
        '[]',
        config,
        resolved!.params,
        'workflow.agentDefaults.panel.reviewers',
      )).toEqual([]);
    });

    it('lists the builtin worker agents as options', () => {
      const config = getDefaultConfig();
      const resolved = resolveConfigPath('workflow.agentDefaults.iterate.implementer');
      expect(resolved!.descriptor.options(config, resolved!.params)).toEqual([
        'agy',
        'claude-code',
        'codex',
      ]);
    });
  });

  it('returns null for unsupported paths', () => {
    expect(resolveConfigPath('captain.cli')).toBeNull();
    expect(resolveConfigPath('workflow.reviewer.maxPasses')).toBeNull();
    expect(resolveConfigPath('agents.codex.model')).toBeNull();
    expect(resolveConfigPath('not.a.path')).toBeNull();
  });
});
