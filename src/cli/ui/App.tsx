import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp } from 'ink';
import { ConversationView, type ChatMessage } from './ConversationView.js';
import { AgentStatus, type AgentInfo } from './AgentStatus.js';
import { PromptInput } from './PromptInput.js';
import type { Pipeline } from '../../orchestrator/pipeline.js';

const STEP_LABELS: Record<string, string> = {
  decompose: 'Decomposing request into tasks...',
  dispatch: 'Crafting agent prompt...',
  ingest: 'Analyzing agent output...',
  summarize: 'Summarizing pass...',
  judge: 'Evaluating quality...',
  report: 'Generating report...',
};

interface Props {
  pipeline: Pipeline;
  initialPrompt?: string;
}

export function App({ pipeline, initialPrompt }: Props) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [waitingForInput, setWaitingForInput] = useState(false);
  const inputQueueRef = useRef<string[]>([]);

  const addMessage = useCallback((role: ChatMessage['role'], content: string) => {
    setMessages(prev => [...prev, { role, content }]);
  }, []);

  useEffect(() => {
    pipeline.on('step:start', (step) => {
      setCurrentStep(STEP_LABELS[step] ?? `Running ${step}...`);
      addMessage('system', `Starting step: ${step}`);
    });

    pipeline.on('step:complete', () => {
      setCurrentStep(null);
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
      setCurrentStep(null);
      setIsRunning(false);
    });

    pipeline.on('ask_user', (question) => {
      addMessage('assistant', question);
      setCurrentStep(null);

      // Check for queued input
      const queued = inputQueueRef.current.shift();
      if (queued) {
        addMessage('user', `(queued) ${queued}`);
        pipeline.provideUserInput(queued);
      } else {
        setWaitingForInput(true);
      }
    });

    pipeline.on('error', (error) => {
      addMessage('system', `Error: ${error.message}`);
      setCurrentStep(null);
      setIsRunning(false);
    });

    return () => {
      pipeline.removeAllListeners();
    };
  }, [pipeline, addMessage]);

  const handleSubmit = useCallback((input: string) => {
    if (waitingForInput) {
      // Pipeline is paused waiting for input — send it
      addMessage('user', input);
      setWaitingForInput(false);
      pipeline.provideUserInput(input);
    } else if (isRunning) {
      // Pipeline is running — queue the input
      inputQueueRef.current.push(input);
      addMessage('user', `(queued) ${input}`);
    } else {
      // Pipeline is idle — start a new run
      addMessage('user', input);
      setIsRunning(true);
      setAgents([]);
      inputQueueRef.current = [];

      pipeline.run(input).catch((err) => {
        addMessage('system', `Pipeline error: ${err instanceof Error ? err.message : String(err)}`);
        setIsRunning(false);
        setCurrentStep(null);
      });
    }
  }, [pipeline, addMessage, isRunning, waitingForInput]);

  useEffect(() => {
    if (initialPrompt) {
      handleSubmit(initialPrompt);
    }
  }, [initialPrompt, handleSubmit]);

  const statusText = waitingForInput
    ? 'Waiting for your input...'
    : currentStep ?? undefined;

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
        <PromptInput
          onSubmit={handleSubmit}
          disabled={isRunning && !waitingForInput}
          statusText={statusText}
        />
      </Box>
    </Box>
  );
}
