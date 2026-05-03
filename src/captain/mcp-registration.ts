import { createHash } from 'node:crypto';

/**
 * Seam for registering MCP servers with each captain CLI per-invocation.
 *
 * Claude and Gemini take per-invocation flags for MCP servers
 * (`--mcp-config`, `--allowed-mcp-server-names`). Codex does not — it reads
 * MCP config from `~/.codex/config.toml` or a named profile. The one
 * approximation Codex offers is `-c key=value` overrides, which *can* set
 * `mcp_servers.<name>.*` keys on the fly.
 *
 * M3 wires the captain's tool registry through this module so a per-session
 * tool catalog can be projected into each CLI's native shape. For M0.5 the
 * shape is a stub: `ToolCatalog` is an empty placeholder type and the
 * builders all return empty argv fragments. M3 fills in the real catalog
 * without touching any adapter.
 */

/**
 * The per-session tool catalog. Converters (Codex argv, Claude inline JSON,
 * Gemini settings) consume the `mcpServers` list; M3-7's parity tests lock
 * the three projections together.
 *
 * `crewTools` documents the "source of truth" invariant — the tools the
 * captain sees come from the same catalog as the MCP-server list. The
 * converters themselves don't read `crewTools`, but keeping it on the
 * catalog shape means adding a new captain tool is visible here too.
 *
 * The plain `ToolCatalog` interface is the narrow shape the converters
 * consume; the richer `ToolCatalogClass` in `./tools/catalog.ts` implements
 * it and also carries the ActionCatalogEntry projection.
 */
export interface ToolCatalog {
  readonly mcpServers?: ReadonlyArray<McpServerSpec>;
  readonly crewTools?: ReadonlyArray<import('../adapters/types.js').ToolDefinition>;
}

export interface McpServerSpec {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Turns a `ToolCatalog` into the `-c mcp_servers.<name>.<key>=<value>`
 * argv fragment consumed by `codex exec`. Values are serialized as TOML
 * literals (strings quoted, arrays bracketed) — Codex parses the key/value
 * pair per TOML rules.
 *
 * Returns `[]` for an empty catalog so callers can unconditionally spread
 * the result into argv. M0.5 ships this stub; M3 fills in a real catalog.
 */
export function toCodexConfigOverrides(catalog: ToolCatalog): string[] {
  const servers = catalog.mcpServers ?? [];
  if (servers.length === 0) return [];

  const flags: string[] = [];
  for (const server of servers) {
    const prefix = `mcp_servers.${server.name}`;
    flags.push('-c', `${prefix}.command=${toTomlString(server.command)}`);
    if (server.args && server.args.length > 0) {
      flags.push('-c', `${prefix}.args=${toTomlStringArray(server.args)}`);
    }
    if (server.cwd) {
      flags.push('-c', `${prefix}.cwd=${toTomlString(server.cwd)}`);
    }
    if (server.env) {
      for (const [key, value] of Object.entries(server.env)) {
        flags.push('-c', `${prefix}.env.${key}=${toTomlString(value)}`);
      }
    }
  }
  return flags;
}

function toTomlString(value: string): string {
  // TOML basic string: double-quoted, with backslash/quote escaping.
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function toTomlStringArray(values: readonly string[]): string {
  return `[${values.map(toTomlString).join(', ')}]`;
}

/**
 * Turns a `ToolCatalog` into the inline JSON string Claude accepts via
 * `claude --mcp-config <json-or-path>`. Shape:
 *
 *   { "mcpServers": { "<name>": { "command": ..., "args": ..., ... } } }
 *
 * Returns `undefined` when the catalog has no servers so the adapter omits
 * the `--mcp-config` flag entirely. Recent claude-code CLI versions reject
 * `--mcp-config '{}'` and `--mcp-config '{"mcpServers":{}}'` as invalid
 * schema, so the flag must be absent rather than empty.
 *
 * M3-8 threads this through claude-code.ts' argv assembly.
 */
export function toClaudeMcpConfigJson(catalog: ToolCatalog): string | undefined {
  const servers = catalog.mcpServers ?? [];
  if (servers.length === 0) return undefined;
  const mcpServers: Record<string, {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  }> = {};
  for (const server of servers) {
    const entry: typeof mcpServers[string] = {
      command: server.command,
    };
    if (server.args && server.args.length > 0) entry.args = [...server.args];
    if (server.cwd) entry.cwd = server.cwd;
    if (server.env) entry.env = { ...server.env };
    mcpServers[server.name] = entry;
  }
  return JSON.stringify({ mcpServers });
}

export interface GeminiMcpSettings {
  /**
   * File content for `~/.gemini/settings.json`. Top-level shape is
   * `{ mcpServers: { [name]: ... } }` matching upstream's documented
   * format. M3-9 atomically writes this to disk when the catalog hash drifts.
   */
  readonly settingsJson: {
    readonly mcpServers: Readonly<Record<string, {
      readonly command: string;
      readonly args?: readonly string[];
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
    }>>;
  };
  /**
   * CSV-ready list of server names, sorted deterministically so the
   * CLI argv is stable across runs. Adapter joins with `,` and passes
   * as `--allowed-mcp-server-names`.
   */
  readonly allowedServerNames: readonly string[];
}

/**
 * Turns a `ToolCatalog` into the settings.json content + the per-invocation
 * allowed-names list. Two outputs because Gemini's native wiring splits them:
 * settings.json is file-based, allowed-names is per-invocation.
 *
 * Both derive from the catalog's server list, so drift is impossible as long
 * as the callers use this function instead of hand-rolling either half.
 */
/**
 * Thin helper the session-loop uses when building the per-turn adapter
 * payload. Given the captain adapter name, returns the `McpRegistrationPayload`
 * the adapter will consume. Keeps the per-captain branching in one place so
 * M3-8 adapters don't each reimplement the catalog→shape projection.
 *
 * Unknown adapter names (generic, openai-compatible) return undefined —
 * those adapters do not yet participate in MCP registration.
 */
export function resolveCaptainConverter(
  adapterName: string,
  catalog: ToolCatalog,
): import('../adapters/types.js').McpRegistrationPayload | undefined {
  switch (adapterName) {
    case 'claude-code':
      return {
        kind: 'claude-code',
        inlineConfigJson: toClaudeMcpConfigJson(catalog),
      };
    case 'gemini-cli':
      return {
        kind: 'gemini-cli',
        allowedServerNames: toGeminiMcpSettings(catalog).allowedServerNames,
      };
    case 'codex':
      return {
        kind: 'codex',
        configOverrideArgv: toCodexConfigOverrides(catalog),
      };
    default:
      return undefined;
  }
}

/**
 * Hash the canonical JSON of the Gemini settings-file content. Used by M3-9's
 * catalog-lockfile machinery: the file is regenerated iff this hash changes.
 *
 * Keyed on the *settings.json* shape, not on the tool catalog as a whole —
 * two catalogs that produce the same settings.json are considered equivalent
 * even if their other projections (Claude JSON, Codex argv) differ. Two
 * catalogs with identical server lists in a different insertion order hash
 * to the same value because `JSON.stringify` over an Object preserves
 * insertion order but the server names get sorted via `allowedServerNames`
 * only for CSV output — settings.json retains whatever order the catalog
 * hands in. To keep the hash drift-free under shuffle, sort the keys here.
 */
export function hashGeminiSettings(catalog: ToolCatalog): string {
  const settings = toGeminiMcpSettings(catalog).settingsJson;
  // Canonicalize: sort keys recursively so insertion order doesn't affect the hash.
  const canonical = JSON.stringify(sortKeys(settings));
  return createHash('sha256').update(canonical).digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = sortKeys(obj[key]);
      return acc;
    }, {});
}

export function toGeminiMcpSettings(catalog: ToolCatalog): GeminiMcpSettings {
  const servers = catalog.mcpServers ?? [];
  const mcpServers: GeminiMcpSettings['settingsJson']['mcpServers'] = {};
  const allowedServerNames: string[] = [];
  for (const server of servers) {
    const entry: GeminiMcpSettings['settingsJson']['mcpServers'][string] = {
      command: server.command,
    };
    if (server.args && server.args.length > 0) {
      Object.assign(entry, { args: [...server.args] });
    }
    if (server.cwd) {
      Object.assign(entry, { cwd: server.cwd });
    }
    if (server.env) {
      Object.assign(entry, { env: { ...server.env } });
    }
    (mcpServers as Record<string, unknown>)[server.name] = entry;
    allowedServerNames.push(server.name);
  }
  allowedServerNames.sort();
  return {
    settingsJson: { mcpServers },
    allowedServerNames,
  };
}
