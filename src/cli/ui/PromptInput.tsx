import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

interface Props {
  onSubmit: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function PromptInput({ onSubmit, placeholder = 'Type a message...', disabled = false }: Props) {
  const [value, setValue] = useState('');

  const handleSubmit = (input: string) => {
    if (input.trim()) {
      onSubmit(input.trim());
      setValue('');
    }
  };

  if (disabled) {
    return (
      <Box paddingX={1}>
        <Text dimColor>Working...</Text>
      </Box>
    );
  }

  return (
    <Box paddingX={1}>
      <Text color="cyan" bold>{'\u276F '}</Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder={placeholder}
      />
    </Box>
  );
}
