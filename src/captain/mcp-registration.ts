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
 * Placeholder for M3's tool catalog. Intentionally minimal at M0.5; M3 will
 * widen this to include tool schemas, MCP server entries, and so on.
 */
export interface ToolCatalog {
  readonly mcpServers?: ReadonlyArray<{
    readonly name: string;
    readonly command: string;
    readonly args?: readonly string[];
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
  }>;
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
