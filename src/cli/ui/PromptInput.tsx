import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const MAX_HISTORY = 200;

interface Props {
  onSubmit: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  statusText?: string;
}

export function PromptInput({ onSubmit, placeholder = 'Type a message...', disabled = false, statusText }: Props) {
  const [value, setValue] = useState('');
  const [frame, setFrame] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [draftBeforeHistory, setDraftBeforeHistory] = useState('');

  useEffect(() => {
    if (!disabled || !statusText) return;
    const timer = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, [disabled, statusText]);

  useInput((_input, key) => {
    if (disabled || history.length === 0) return;

    if (key.upArrow) {
      if (historyIndex === null) {
        setDraftBeforeHistory(value);
        const nextIndex = history.length - 1;
        setHistoryIndex(nextIndex);
        setValue(history[nextIndex]);
        return;
      }

      if (historyIndex > 0) {
        const nextIndex = historyIndex - 1;
        setHistoryIndex(nextIndex);
        setValue(history[nextIndex]);
      }
      return;
    }

    if (key.downArrow && historyIndex !== null) {
      if (historyIndex < history.length - 1) {
        const nextIndex = historyIndex + 1;
        setHistoryIndex(nextIndex);
        setValue(history[nextIndex]);
        return;
      }

      setHistoryIndex(null);
      setValue(draftBeforeHistory);
      setDraftBeforeHistory('');
    }
  }, { isActive: !disabled });

  const handleSubmit = (input: string) => {
    const trimmed = input.trim();
    if (trimmed) {
      onSubmit(trimmed);
      setHistory(prev => {
        if (prev[prev.length - 1] === trimmed) return prev;
        const next = [...prev, trimmed];
        return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
      });
      setHistoryIndex(null);
      setDraftBeforeHistory('');
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
