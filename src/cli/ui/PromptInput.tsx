import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface Props {
  onSubmit: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  statusText?: string;
}

export function PromptInput({ onSubmit, placeholder = 'Type a message...', disabled = false, statusText }: Props) {
  const [value, setValue] = useState('');
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!disabled || !statusText) return;
    const timer = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, [disabled, statusText]);

  const handleSubmit = (input: string) => {
    if (input.trim()) {
      onSubmit(input.trim());
      setValue('');
    }
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      {disabled && statusText && (
        <Box marginBottom={0}>
          <Text color="yellow">{SPINNER_FRAMES[frame]} </Text>
          <Text dimColor>{statusText}</Text>
        </Box>
      )}
      <Box>
        <Text color="cyan" bold>{'\u276F '}</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder={disabled ? '' : placeholder}
        />
      </Box>
    </Box>
  );
}
