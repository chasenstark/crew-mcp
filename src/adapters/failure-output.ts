const FAILURE_TEXT_HEAD_BYTES = 4 * 1024;
const FAILURE_TEXT_TAIL_BYTES = 60 * 1024;

/**
 * Keep process diagnostics useful without letting a provider's full output
 * become a durable run summary. Byte-based slicing keeps the cap meaningful
 * for non-ASCII output too; Buffer decoding may replace a split boundary code
 * point, but preserves the requested head/tail evidence and exact byte count.
 */
export function boundFailureText(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  const retainedBytes = FAILURE_TEXT_HEAD_BYTES + FAILURE_TEXT_TAIL_BYTES;
  if (bytes.byteLength <= retainedBytes) return text;

  const truncatedBytes = bytes.byteLength - retainedBytes;
  const head = bytes.subarray(0, FAILURE_TEXT_HEAD_BYTES).toString('utf8');
  const tail = bytes.subarray(bytes.byteLength - FAILURE_TEXT_TAIL_BYTES).toString('utf8');
  return `${head}\n[... ${truncatedBytes} bytes truncated ...]\n${tail}`;
}
