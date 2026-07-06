export const REDACTED_RUN_TOKEN = '«redacted-run-token»';

export function redactRunToken(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join(REDACTED_RUN_TOKEN);
}
