import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp } from 'ink';
import { ConversationView, type ChatMessage } from './ConversationView.js';
import { AgentStatus, type AgentInfo } from './AgentStatus.js';
import { PromptInput } from './PromptInput.js';
import type { Pipeline } from '../../orchestrator/pipeline.js';

interface Props {
  pipeline: Pipeline;
  initialPrompt?: string;
}

export function App({ pipeline, initialPrompt }: Props) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [isRunning, setIsRunning] = useState(false);

  const addMessage = useCallback((role: ChatMessage['role'], content: string) => {
    setMessages(prev => [...prev, { role, content }]);
  }, []);

  useEffect(() => {
    pipeline.on('step:start', (step) => {
      addMessage('system', `Starting step: ${step}`);
    });

    pipeline.on('agent:start', (name, task) => {
      setAgents(prev => [
        ...prev.filter(a => a.name !== name),
        { name, status: 'running', task, startedAt: Date.now() },
      ]);
    });

    pipeline.on('agent:complete', (name, _taskId, result) => {
      setAgents(prev =>
        prev.map(a => a.name === name
          ? { ...a, status: result.status === 'success' ? 'done' : 'error' }
          : a
        ),
      );
    });

    pipeline.on('report', (message) => {
      addMessage('assistant', message);
      setIsRunning(false);
    });

    pipeline.on('ask_user', (question) => {
      addMessage('assistant', question);
      setIsRunning(false);
    });

    pipeline.on('error', (error) => {
      addMessage('system', `Error: ${error.message}`);
      setIsRunning(false);
    });

    return () => {
      pipeline.removeAllListeners();
    };
  }, [pipeline, addMessage]);

  const handleSubmit = useCallback(async (input: string) => {
    addMessage('user', input);
    setIsRunning(true);
    setAgents([]);

    try {
      await pipeline.run(input);
    } catch (err) {
      addMessage('system', `Pipeline error: ${err instanceof Error ? err.message : String(err)}`);
      setIsRunning(false);
    }
  }, [pipeline, addMessage]);

  useEffect(() => {
    if (initialPrompt) {
      handleSubmit(initialPrompt).catch(() => {}); // errors handled inside
    }
  }, [initialPrompt, handleSubmit]);

  return (
    <Box flexDirection="column" minHeight={10}>
      <Box borderStyle="round" borderColor="blue" paddingX={1} marginBottom={1}>
        <Text bold color="blue"> orchestrator </Text>
        <Text dimColor> {'\u2014'} agent orchestration through conversation</Text>
      </Box>

      <ConversationView messages={messages} />

      {agents.length > 0 && (
        <Box marginY={1}>
          <AgentStatus agents={agents} />
        </Box>
      )}

      <Box marginTop={1}>
        <PromptInput onSubmit={handleSubmit} disabled={isRunning} />
      </Box>
    </Box>
  );
}
