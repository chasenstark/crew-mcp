import type { ResolvedCaps } from './caps.js';
import type { PeerMessageInput } from './schema.js';

export function validatePeerMessagesPreflight(
  input: readonly PeerMessageInput[] | undefined,
  caps: Pick<ResolvedCaps, 'maxItems' | 'maxExcerpts'>,
): readonly PeerMessageInput[] {
  const messages = input ?? [];
  if (messages.length > caps.maxItems) {
    throw new Error(
      `peer_messages.too_many: ${messages.length} items exceeds cap ${caps.maxItems}`,
    );
  }

  messages.forEach((message, index) => {
    const excerptCount = message.excerpts?.length ?? 0;
    if (excerptCount > caps.maxExcerpts) {
      throw new Error(
        `peer_messages.too_many_excerpts: item[${index}] has ${excerptCount} ` +
        `excerpts, cap ${caps.maxExcerpts}`,
      );
    }
  });

  return messages;
}
