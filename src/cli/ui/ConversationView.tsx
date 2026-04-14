import React from 'react';
import { Box, Text } from 'ink';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'stream';
  content: string;
  agentName?: string;
}

interface Props {
  messages: ChatMessage[];
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed) return trimmed;
  }
  return '';
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
            // Streaming view: show only the last non-empty line to keep the
            // pane compact while an agent is talking. Full buffered content
            // is preserved on the message — a future UI affordance (e.g. an
            // "expand" keybind) can reveal the whole transcript on demand.
            <Box flexDirection="column">
              <Text color="magenta" dimColor>{`\u258E ${msg.agentName ?? 'agent'} (streaming)`}</Text>
              <Text dimColor>{lastNonEmptyLine(msg.content)}</Text>
            </Box>
          ) : (
            <Text>{msg.content}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
