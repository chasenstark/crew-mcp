/**
 * Convert an absolute filesystem path to the custom URL handled by the
 * optional macOS CrewTail.app LaunchServices registration.
 *
 * We keep path separators literal for readability (`crew-tail:///Users/...`)
 * but still escape URI delimiters that are legal filename characters. Plain
 * encodeURI() would leave `#` and `?` unescaped, causing URL parsers to treat
 * them as fragment/query delimiters instead of path bytes.
 */
export function crewTailUrl(absolutePath: string): string {
  return 'crew-tail://' + encodeURI(absolutePath)
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
}
