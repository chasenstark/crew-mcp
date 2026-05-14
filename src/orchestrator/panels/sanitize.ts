import { peerMessageInputSchema } from '../peer-messages/schema.js';

const FROM_LABEL_FORBIDDEN = /[\x00-\x1f\x7f`#\r\n]/g;
const FROM_LABEL_MAX = 80;

export function sanitizeFromLabel(raw: string, suffix?: string): string {
  const cleanedRaw = raw.replace(FROM_LABEL_FORBIDDEN, '_');
  const cleanedSuffix = suffix?.replace(FROM_LABEL_FORBIDDEN, '_');
  const composed = cleanedSuffix && cleanedSuffix.length > 0
    ? `${cleanedRaw} (${cleanedSuffix})`
    : cleanedRaw;
  const sanitized = composed.length > FROM_LABEL_MAX
    ? composed.slice(0, FROM_LABEL_MAX)
    : composed;
  peerMessageInputSchema.shape.from_label.parse(sanitized);
  return sanitized;
}
