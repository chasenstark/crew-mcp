import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp } from 'ink';
import { ConversationView, type ChatMessage } from './ConversationView.js';
import { AgentStatus, type AgentInfo } from './AgentStatus.js';
import { PromptInput } from './PromptInput.js';
import { handleConfigSlashCommand } from './config/command-handler.js';
import type { OrchestrationRunner } from '../../orchestrator/runner.js';
import { formatStepComplete, formatStepStart, getStepLabel } from '../step-status.js';

function summarizeTask(description: string, taskId: string, maxLen = 60): string {
  const text = description?.trim();
  if (!text) return taskId;
  const firstLine = text.split('\n')[0].replace(/\s+/g, ' ').trim();
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen - 1).trimEnd() + '\u2026';
}

interface Props {
  pipeline: OrchestrationRunner;
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

  const streamKeyRef = useRef<string | null>(null);

  const appendStreamChunk = useCallback((agentName: string, taskId: string, chunk: string) => {
    const key = `${agentName}:${taskId}`;
    setMessages(prev => {
      if (streamKeyRef.current === key && prev.length > 0 && prev[prev.length - 1].role === 'stream') {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          content: updated[updated.length - 1].content + chunk,
          latestChunk: chunk,
        };
        return updated;
      }
      streamKeyRef.current = key;
      return [...prev, { role: 'stream', content: chunk, latestChunk: chunk, agentName }];
    });
  }, []);

  const finalizeStream = useCallback(() => {
    streamKeyRef.current = null;
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

    pipeline.on('agent:start', (name, taskId, description) => {
      const label = summarizeTask(description, taskId);
      setAgents(prev => [
        ...prev.filter(a => a.name !== name),
        { name, status: 'running', task: label, startedAt: Date.now() },
      ]);
    });

    pipeline.on('agent:output', (name, taskId, chunk) => {
      appendStreamChunk(name, taskId, chunk);
    });

    pipeline.on('agent:complete', (name, _taskId, result) => {
      finalizeStream();
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
  }, [pipeline, addMessage, appendStreamChunk, finalizeStream]);

  const handleSubmit = useCallback((input: string) => {
    if (input.startsWith('/config')) {
      try {
        const response = handleConfigSlashCommand(input, {
          cwd: process.cwd(),
          isRunning,
        });
        if (response) {
          addMessage('system', response);
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        addMessage('system', `Config error: ${message}`);
        return;
      }
    }

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
      if (input === '/cancel') {
        pipeline.cancel('Cancelled by user from interactive session');
        inputQueueRef.current = [];
        setQueueCount(0);
        finalizeStream();
        setIsRunning(false);
        setWaitingForInput(false);
        setCurrentStep(null);
        addMessage('system', 'Cancelled. Workflow state saved as interrupted — rerun to resume.');
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
  }, [pipeline, addMessage, isRunning, waitingForInput, finalizeStream]);

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
        ? `${currentStep ?? 'Running...'} (${queueCount} queued — /clear-queue or /cancel)`
        : `${currentStep ?? 'Running...'} (type /cancel to stop)`
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
