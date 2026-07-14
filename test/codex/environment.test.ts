import { describe, expect, it } from 'vitest';

import {
  codexSafeSpawnEnvironment,
  withoutCodexCaptainEnvironment,
} from '../../src/codex/environment.js';

describe('Codex captain environment isolation', () => {
  const capabilityEnvironment = {
    PATH: '/opt/bin',
    CREW_CODEX_BRIDGE_FILE: '/tmp/bridge.json',
    CREW_CODEX_REMOTE_TOKEN: 'remote-token',
    CODEX_THREAD_ID: 'thread-id',
  };

  it('removes every hosted-captain capability while preserving ordinary variables', () => {
    expect(withoutCodexCaptainEnvironment(capabilityEnvironment)).toEqual({
      PATH: '/opt/bin',
    });
  });

  it('disables execa parent-environment merging', () => {
    expect(codexSafeSpawnEnvironment(capabilityEnvironment)).toEqual({
      env: { PATH: '/opt/bin' },
      extendEnv: false,
    });
  });
});
