/**
 * Resolve the absolute crew binary the host CLI should spawn.
 *
 * In production, `crew install` is invoked from the same npm-installed
 * binary the host CLI will later spawn. We capture:
 *
 *   - process.execPath  — node interpreter (cross-platform safe)
 *   - process.argv[1]   — absolute path to dist/index.js (the script
 *                         node was invoked with; resolved through
 *                         npm's bin shim or symlink already)
 *
 * That pair is what we write into the host's MCP config. Users who
 * later move their npm prefix or reinstall will need to `crew install`
 * again — this is documented in the README.
 *
 * Tests inject `CrewBinaryResolver` to bypass argv resolution.
 */

export interface ResolvedCrewBinary {
  /** Absolute path to the executable to run (typically node). */
  readonly command: string;
  /** Args passed to that executable (script path + 'serve'). */
  readonly args: readonly string[];
}

export type CrewBinaryResolver = () => ResolvedCrewBinary;

/**
 * Default resolver — used in production. argv[1] is the script path
 * node was invoked with; in npm-shim invocations that resolves to the
 * real dist/index.js inside the install location. Throws if argv[1]
 * is somehow missing (would indicate a broken Node invocation).
 */
export const defaultCrewBinaryResolver: CrewBinaryResolver = () => {
  const scriptPath = process.argv[1];
  if (!scriptPath || scriptPath.length === 0) {
    throw new Error(
      'Cannot resolve crew binary: process.argv[1] is empty. Are you running crew via an unusual launcher?',
    );
  }
  return {
    command: process.execPath,
    args: [scriptPath, 'serve'],
  };
};
