import React from 'react';
import { Box, Text } from 'ink';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'stream';
  content: string;
  // For 'stream' messages: only the most recent chunk is rendered live. The
  // full buffer is kept in `content` so a future expand affordance can show
  // the whole transcript.
  latestChunk?: string;
  agentName?: string;
}

interface Props {
  messages: ChatMessage[];
}

const STREAM_LINE_MAX = 120;

function oneLinePreview(text: string): string {
  const firstLine = text.split('\n').find((l) => l.trim()) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= STREAM_LINE_MAX) return collapsed;
  return collapsed.slice(0, STREAM_LINE_MAX - 1).trimEnd() + '\u2026';
}

export function ConversationView({ messages }: Props) {
  return (
    <Box flexDirection="column" paddingX={1}>
      {messages.map((msg, i) => (
        <Box key={`${msg.role}-${i}`} marginBottom={1}>
          {msg.role === 'user' ? (
            <Text>
              <Text color="cyan" bold>{'\u2192 '}</Text>
              <Text>{msg.content}</Text>
            </Text>
          ) : msg.role === 'system' ? (
            <Text dimColor>{msg.content}</Text>
          ) : msg.role === 'stream' ? (
            // Streaming view: render only the most recent chunk, clipped to
            // one line. Full buffered content is preserved on msg.content so
            // a future expand affordance can reveal the whole transcript.
            <Box flexDirection="column">
              <Text color="magenta" dimColor>{`\u258E ${msg.agentName ?? 'agent'} (streaming)`}</Text>
              <Text dimColor wrap="truncate-end">{oneLinePreview(msg.latestChunk ?? msg.content)}</Text>
            </Box>
          ) : (
            <Text>{msg.content}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
