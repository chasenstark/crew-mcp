import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp } from 'ink';
import { ConversationView, type ChatMessage } from './ConversationView.js';
import { AgentStatus, type AgentInfo } from './AgentStatus.js';
import { PromptInput } from './PromptInput.js';
import type { Pipeline } from '../../orchestrator/pipeline.js';
import { formatStepComplete, formatStepStart, getStepLabel } from '../step-status.js';

interface Props {
  pipeline: Pipeline;
  initialPrompt?: string;
}

export function App({ pipeline, initialPrompt }: Props) {
  useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [waitingForInput, setWaitingForInput] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const inputQueueRef = useRef<string[]>([]);

  const addMessage = useCallback((role: ChatMessage['role'], content: string) => {
    setMessages(prev => [...prev, { role, content }]);
  }, []);

  useEffect(() => {
    pipeline.on('step:start', (step, data) => {
      setCurrentStep(getStepLabel(step));
      addMessage('system', `Step start  [${step}]  ${formatStepStart(step, data)}`);
    });

    pipeline.on('step:complete', (step, data) => {
      addMessage('system', `Step done   [${step}]  ${formatStepComplete(step, data)}`);
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
      setWaitingForInput(false);
      inputQueueRef.current = [];
      setQueueCount(0);
    });

    pipeline.on('ask_user', (question) => {
      addMessage('assistant', question);
      setCurrentStep(null);

      // Check for queued input
      const queued = inputQueueRef.current.shift();
      setQueueCount(inputQueueRef.current.length);
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
      setWaitingForInput(false);
      inputQueueRef.current = [];
      setQueueCount(0);
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
      if (input === '/clear' || input === '/clear-queue') {
        const cleared = inputQueueRef.current.length;
        inputQueueRef.current = [];
        setQueueCount(0);
        addMessage('system', `Cleared ${cleared} queued message${cleared === 1 ? '' : 's'}.`);
        return;
      }
      // Pipeline is running — queue the input
      inputQueueRef.current.push(input);
      setQueueCount(inputQueueRef.current.length);
      addMessage('user', `(queued) ${input}`);
    } else {
      // Pipeline is idle — start a new run
      addMessage('user', input);
      setIsRunning(true);
      setAgents([]);
      inputQueueRef.current = [];
      setQueueCount(0);

      pipeline.run(input).catch((err) => {
        addMessage('system', `Pipeline error: ${err instanceof Error ? err.message : String(err)}`);
        setIsRunning(false);
        setCurrentStep(null);
        setWaitingForInput(false);
        setQueueCount(0);
      });
    }
  }, [pipeline, addMessage, isRunning, waitingForInput]);

  useEffect(() => {
    if (initialPrompt) {
      handleSubmit(initialPrompt);
    }
  }, [initialPrompt, handleSubmit]);

  const statusText = waitingForInput
    ? queueCount > 0
      ? `Waiting for your input... (${queueCount} queued)`
      : 'Waiting for your input...'
    : isRunning
      ? queueCount > 0
        ? `${currentStep ?? 'Running...'} (${queueCount} queued, type /clear-queue to clear)`
        : currentStep ?? 'Running...'
      : undefined;

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
