import React from 'react';
import { Box, Text } from 'ink';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
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
          ) : (
            <Text>{msg.content}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
