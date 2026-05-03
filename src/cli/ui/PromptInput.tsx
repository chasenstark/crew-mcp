import React, { useState, useEffect, useRef } from 'react';
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
  const valueRef = useRef(value);
  const historyRef = useRef(history);
  const historyIndexRef = useRef(historyIndex);
  const draftBeforeHistoryRef = useRef(draftBeforeHistory);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    historyIndexRef.current = historyIndex;
  }, [historyIndex]);

  useEffect(() => {
    draftBeforeHistoryRef.current = draftBeforeHistory;
  }, [draftBeforeHistory]);

  const updateValue = (nextValue: string) => {
    valueRef.current = nextValue;
    setValue(nextValue);
  };

  const updateHistoryIndex = (nextIndex: number | null) => {
    historyIndexRef.current = nextIndex;
    setHistoryIndex(nextIndex);
  };

  const updateDraftBeforeHistory = (nextDraft: string) => {
    draftBeforeHistoryRef.current = nextDraft;
    setDraftBeforeHistory(nextDraft);
  };

  useEffect(() => {
    if (!disabled || !statusText) return;
    const timer = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, [disabled, statusText]);

  useInput((_input, key) => {
    const currentHistory = historyRef.current;
    if (disabled || currentHistory.length === 0) return;
    const currentHistoryIndex = historyIndexRef.current;

    if (key.upArrow) {
      if (currentHistoryIndex === null) {
        updateDraftBeforeHistory(valueRef.current);
        const nextIndex = currentHistory.length - 1;
        updateHistoryIndex(nextIndex);
        updateValue(currentHistory[nextIndex]);
        return;
      }

      if (currentHistoryIndex > 0) {
        const nextIndex = currentHistoryIndex - 1;
        updateHistoryIndex(nextIndex);
        updateValue(currentHistory[nextIndex]);
      }
      return;
    }

    if (key.downArrow && currentHistoryIndex !== null) {
      if (currentHistoryIndex < currentHistory.length - 1) {
        const nextIndex = currentHistoryIndex + 1;
        updateHistoryIndex(nextIndex);
        updateValue(currentHistory[nextIndex]);
        return;
      }

      updateHistoryIndex(null);
      updateValue(draftBeforeHistoryRef.current);
      updateDraftBeforeHistory('');
    }
  }, { isActive: !disabled });

  const handleSubmit = (input: string) => {
    const trimmed = input.trim();
    if (trimmed) {
      onSubmit(trimmed);
      setHistory(prev => {
        if (prev[prev.length - 1] === trimmed) return prev;
        const next = [...prev, trimmed];
        const bounded = next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
        historyRef.current = bounded;
        return bounded;
      });
      updateHistoryIndex(null);
      updateDraftBeforeHistory('');
      updateValue('');
    }
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      {statusText && (
        <Box marginBottom={0}>
          <Text color={disabled ? 'yellow' : 'gray'}>
            {disabled ? SPINNER_FRAMES[frame] : '\u25CF'}{' '}
          </Text>
          <Text dimColor>{statusText}</Text>
        </Box>
      )}
      <Box>
        <Text color="cyan" bold>{'\u276F '}</Text>
        <TextInput
          value={value}
          onChange={updateValue}
          onSubmit={handleSubmit}
          placeholder={disabled ? '' : placeholder}
        />
      </Box>
    </Box>
  );
}
