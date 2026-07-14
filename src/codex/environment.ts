import {
  CODEX_BRIDGE_FILE_ENV,
  CODEX_THREAD_ID_ENV,
} from './app-server-bridge.js';

export const CODEX_REMOTE_TOKEN_ENV = 'CREW_CODEX_REMOTE_TOKEN';

/**
 * Remove captain App Server capabilities before spawning any child that is
 * not the installed Crew MCP process itself. Execa merges `env` with the
 * parent by default, so callers must also pass `extendEnv: false`.
 */
export function withoutCodexCaptainEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  delete sanitized[CODEX_BRIDGE_FILE_ENV];
  delete sanitized[CODEX_REMOTE_TOKEN_ENV];
  delete sanitized[CODEX_THREAD_ID_ENV];
  return sanitized;
}

export function codexSafeSpawnEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): { readonly env: NodeJS.ProcessEnv; readonly extendEnv: false } {
  return {
    env: withoutCodexCaptainEnvironment(env),
    extendEnv: false,
  };
}
