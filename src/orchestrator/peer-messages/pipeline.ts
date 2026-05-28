import type { ResolvedCaps } from './caps.js';
import { buildPrependBlock } from './prepend.js';
import {
  PEER_MESSAGES_SCHEMA_VERSION,
  type PeerMessageInput,
  type PeerMessageRendered,
} from './schema.js';

export interface PeerMessagesPipelineOptions {
  readonly renderedAt: string;
  readonly renderedInTurn: number;
  readonly caps: Pick<ResolvedCaps, 'body' | 'excerpt' | 'aggregate' | 'hardCeiling'>;
}

export function runPeerMessagesPipeline(
  input: readonly PeerMessageInput[],
  options: PeerMessagesPipelineOptions,
): {
  readonly rendered: string;
  readonly warnings: readonly string[];
  readonly renderedMessages: readonly PeerMessageRendered[];
} {
  const { messages, warnings } = truncateInputs(
    input,
    options.renderedAt,
    options.renderedInTurn,
    options.caps,
  );
  const rendered = buildPrependBlock(messages, {
    aggregateCap: options.caps.aggregate,
    hardCeiling: options.caps.hardCeiling,
  });

  return {
    rendered: rendered.rendered,
    warnings: [...warnings, ...rendered.warnings],
    renderedMessages: rendered.renderedMessages,
  };
}

export function truncateInputs(
  input: readonly PeerMessageInput[],
  renderedAt: string,
  renderedInTurn: number,
  caps: Pick<ResolvedCaps, 'body' | 'excerpt'>,
): {
  readonly messages: readonly PeerMessageRendered[];
  readonly warnings: readonly string[];
} {
  const warnings: string[] = [];
  const messages = input.map((message, messageIndex): PeerMessageRendered => {
    const body = truncateText(message.body, caps.body);
    if (body.truncated) {
      warnings.push(
        `peer_messages.body_truncated: item[${messageIndex}] body was ` +
        `${body.originalLength} chars, capped at ${caps.body}`,
      );
    }

    const excerptTruncations: Array<{ index: number; original_length: number }> = [];
    const excerpts = message.excerpts?.map((excerpt, excerptIndex) => {
      const text = truncateText(excerpt.text, caps.excerpt);
      if (text.truncated) {
        excerptTruncations.push({
          index: excerptIndex,
          original_length: text.originalLength,
        });
        warnings.push(
          `peer_messages.excerpt_truncated: item[${messageIndex}].excerpts[${excerptIndex}] ` +
          `text was ${text.originalLength} chars, capped at ${caps.excerpt}`,
        );
      }
      return {
        file: excerpt.file,
        range: [excerpt.range[0], excerpt.range[1]] as readonly [number, number],
        text: text.value,
      };
    });

    return {
      peer_messages_schema_version: PEER_MESSAGES_SCHEMA_VERSION,
      body: body.value,
      kind: message.kind,
      ...(message.from_label === undefined ? {} : { from_label: message.from_label }),
      ...(message.files === undefined ? {} : { files: [...message.files] }),
      ...(excerpts === undefined ? {} : { excerpts }),
      rendered_at: renderedAt,
      rendered_in_turn: renderedInTurn,
      ...(body.truncated ? { body_truncated: { original_length: body.originalLength } } : {}),
      ...(excerptTruncations.length > 0 ? { excerpt_truncations: excerptTruncations } : {}),
    };
  });

  return { messages, warnings };
}

const TRUNCATION_MARKER_PREFIX = '[... truncated; original was ';
const TRUNCATION_MARKER_SUFFIX = ' chars]';

function truncateText(
  text: string,
  cap: number,
): { readonly value: string; readonly truncated: false }
  | { readonly value: string; readonly truncated: true; readonly originalLength: number } {
  if (text.length <= cap) {
    return { value: text, truncated: false };
  }

  const marker = `${TRUNCATION_MARKER_PREFIX}${text.length}${TRUNCATION_MARKER_SUFFIX}`;
  const prefixLength = Math.max(0, cap - marker.length);
  const value = marker.length >= cap
    ? marker.slice(0, cap)
    : `${text.slice(0, prefixLength)}${marker}`;

  return {
    value,
    truncated: true,
    originalLength: text.length,
  };
}
