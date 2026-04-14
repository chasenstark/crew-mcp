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
            <Box flexDirection="column">
              <Text color="magenta" dimColor>{`\u258E ${msg.agentName ?? 'agent'} (streaming)`}</Text>
              <Text dimColor>{msg.content}</Text>
            </Box>
          ) : (
            <Text>{msg.content}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
