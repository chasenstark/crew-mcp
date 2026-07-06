/**
 * Builds the `<cli>@<version>` tag adapters stamp into run metadata so a
 * run's originating CLI build is identifiable after the fact.
 */
export function buildCliVersionTag(cliName: string, version: string): string {
  return `${cliName}@${version}`;
}
