import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp } from 'ink';
import { ConversationView, type ChatMessage } from './ConversationView.js';
import { AgentStatus, type AgentInfo } from './AgentStatus.js';
import { PromptInput } from './PromptInput.js';
import { handleConfigSlashCommand } from './config/command-handler.js';
import type { CrewRunner } from '../../captain/runner.js';
import type { CaptainSession } from '../../captain/session.js';
import type { ToolDispatcher } from '../../captain/tool-dispatcher.js';
import { formatStepComplete, formatStepStart, getStepLabel } from '../step-status.js';

function summarizeTask(description: string, taskId: string, maxLen = 60): string {
  const text = description?.trim();
  if (!text) return taskId;
  const firstLine = text.split('\n')[0].replace(/\s+/g, ' ').trim();
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen - 1).trimEnd() + '\u2026';
}

interface InFlightToolCall {
  toolCallId: string;
  toolName: string;
  startedAt: number;
  latestChunk?: string;
}

interface Props {
  pipeline: CrewRunner;
  session?: CaptainSession;
  dispatcher?: ToolDispatcher;
  initialPrompt?: string;
}

export function App({ pipeline, session, dispatcher, initialPrompt }: Props) {
  useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [currentStep, setCurrentStep] = useState<string | null>(null);

  // Post-M1.5 state: inFlightToolCalls replaces isRunning/waitingForInput/queue.
  // Session is always available; the captain turn accepts user_message events
  // at any time, so the PromptInput is never disabled.
  const [inFlightToolCalls, setInFlightToolCalls] = useState<Map<string, InFlightToolCall>>(new Map());

  // Legacy fallback: when session+dispatcher aren't provided (e.g., linear Pipeline
  // tests), preserve the slot-based behavior via emitter events so the old test
  // suite keeps compiling until pipeline.ts dies in M3.
  const legacyMode = !session || !dispatcher;
  const [legacyIsRunning, setLegacyIsRunning] = useState(false);
  const [legacyWaitingForInput, setLegacyWaitingForInput] = useState(false);

  const addMessage = useCallback((role: ChatMessage['role'], content: string) => {
    setMessages((prev) => [...prev, { role, content }]);
  }, []);

  const streamKeyRef = useRef<string | null>(null);

  const appendStreamChunk = useCallback((agentName: string, taskId: string, chunk: string) => {
    const key = `${agentName}:${taskId}`;
    setMessages((prev) => {
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
      setAgents((prev) => [
        ...prev.filter((a) => a.name !== name),
        { name, status: 'running', task: label, startedAt: Date.now() },
      ]);
    });

    pipeline.on('agent:output', (name, taskId, chunk) => {
      appendStreamChunk(name, taskId, chunk);
    });

    pipeline.on('agent:complete', (name, _taskId, result) => {
      finalizeStream();
      setAgents((prev) =>
        prev.map((a) =>
          a.name === name
            ? { ...a, status: result.status === 'success' ? 'done' : 'error' }
            : a,
        ),
      );
    });

    pipeline.on('report', (message) => {
      addMessage('assistant', message);
      setCurrentStep(null);
      if (legacyMode) {
        setLegacyIsRunning(false);
        setLegacyWaitingForInput(false);
      }
    });

    if (legacyMode) {
      pipeline.on('ask_user', (question) => {
        addMessage('assistant', question);
        setCurrentStep(null);
        setLegacyWaitingForInput(true);
      });
    }

    pipeline.on('error', (error) => {
      addMessage('system', `Error: ${error.message}`);
      setCurrentStep(null);
      if (legacyMode) {
        setLegacyIsRunning(false);
        setLegacyWaitingForInput(false);
      }
    });

    return () => {
      pipeline.removeAllListeners();
    };
  }, [pipeline, addMessage, appendStreamChunk, finalizeStream, legacyMode]);

  // Wire dispatcher events to inFlightToolCalls state.
  useEffect(() => {
    if (!dispatcher) return;
    const handles = [
      dispatcher.onEvent('run:start', (info) => {
        setInFlightToolCalls((prev) => {
          const next = new Map(prev);
          next.set(info.toolCallId, {
            toolCallId: info.toolCallId,
            toolName: info.toolName,
            startedAt: Date.now(),
          });
          return next;
        });
      }),
      dispatcher.onEvent('run:stream', (info) => {
        setInFlightToolCalls((prev) => {
          const existing = prev.get(info.toolCallId);
          if (!existing) return prev;
          const next = new Map(prev);
          next.set(info.toolCallId, { ...existing, latestChunk: info.chunk });
          return next;
        });
      }),
      dispatcher.onEvent('run:complete', (info) => {
        setInFlightToolCalls((prev) => {
          if (!prev.has(info.toolCallId)) return prev;
          const next = new Map(prev);
          next.delete(info.toolCallId);
          return next;
        });
      }),
      dispatcher.onEvent('run:failed', (info) => {
        setInFlightToolCalls((prev) => {
          if (!prev.has(info.toolCallId)) return prev;
          const next = new Map(prev);
          next.delete(info.toolCallId);
          return next;
        });
      }),
      dispatcher.onEvent('run:cancelled', (info) => {
        setInFlightToolCalls((prev) => {
          if (!prev.has(info.toolCallId)) return prev;
          const next = new Map(prev);
          next.delete(info.toolCallId);
          return next;
        });
      }),
    ];
    return () => {
      for (const h of handles) h.dispose();
    };
  }, [dispatcher]);

  const sessionBusy = inFlightToolCalls.size > 0;

  const handleSubmit = useCallback(
    (input: string) => {
      if (input.startsWith('/config')) {
        try {
          const response = handleConfigSlashCommand(input, {
            cwd: process.cwd(),
            sessionBusy,
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

      // Slash commands for cancellation (session-loop era).
      if (!legacyMode && input.startsWith('/cancel')) {
        const rest = input.slice('/cancel'.length).trim();
        if (rest === '-all' || rest === 'all') {
          const n = dispatcher!.cancelAll('user /cancel-all');
          addMessage('system', `Cancelled ${n} in-flight tool call${n === 1 ? '' : 's'}.`);
          return;
        }
        if (!rest || rest === '') {
          pipeline.cancel('Cancelled by user from interactive session');
          finalizeStream();
          setCurrentStep(null);
          addMessage('system', 'Cancelled. Session terminated; workflow state saved as interrupted.');
          return;
        }
        // /cancel <id>
        const cancelled = dispatcher!.cancel(rest, 'user /cancel');
        addMessage(
          'system',
          cancelled
            ? `Cancelled tool call ${rest}.`
            : `No in-flight tool call with id ${rest}.`,
        );
        return;
      }

      if (legacyMode) {
        if (legacyWaitingForInput) {
          addMessage('user', input);
          setLegacyWaitingForInput(false);
          pipeline.provideUserInput(input);
          return;
        }
        if (legacyIsRunning) {
          if (input === '/cancel') {
            pipeline.cancel('Cancelled by user from interactive session');
            finalizeStream();
            setLegacyIsRunning(false);
            setLegacyWaitingForInput(false);
            setCurrentStep(null);
            addMessage('system', 'Cancelled. Workflow state saved as interrupted — rerun to resume.');
            return;
          }
          // In legacy mode (no session), we can't emit a user_message event, so just record it
          addMessage('system', 'Input received but linear-mode pipeline cannot queue messages.');
          return;
        }
        addMessage('user', input);
        setLegacyIsRunning(true);
        setAgents([]);
        pipeline.run(input).catch((err) => {
          addMessage('system', `Pipeline error: ${err instanceof Error ? err.message : String(err)}`);
          setLegacyIsRunning(false);
          setCurrentStep(null);
          setLegacyWaitingForInput(false);
        });
        return;
      }

      // M1.5 path: emit a user_message session event. If the session is idle
      // (no captain turn running and no pending work), the runner's internal
      // loop will react — but the first-run case also needs an explicit
      // pipeline.run() kick-off since the session-loop isn't running yet
      // until the runner has started.
      addMessage('user', input);
      const hasActiveMessages = session!.getMessages().length > 0;
      if (!hasActiveMessages) {
        // Cold-start: kick off the runner. The initial user_message is the
        // appended-first event; the session-loop picks it up.
        session!.appendUserMessage(input);
        pipeline.run(input).catch((err) => {
          addMessage('system', `Pipeline error: ${err instanceof Error ? err.message : String(err)}`);
        });
      } else {
        // Session is already active; just append. The running session-loop
        // will see the event and schedule a fresh captain turn.
        session!.appendUserMessage(input);
      }
    },
    [pipeline, session, dispatcher, addMessage, finalizeStream, legacyMode, legacyIsRunning, legacyWaitingForInput, sessionBusy],
  );

  useEffect(() => {
    if (initialPrompt) {
      handleSubmit(initialPrompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  const statusText = legacyMode
    ? legacyWaitingForInput
      ? 'Waiting for your input...'
      : legacyIsRunning
        ? `${currentStep ?? 'Running...'} (type /cancel to stop)`
        : undefined
    : sessionBusy
      ? `${inFlightToolCalls.size} tool${inFlightToolCalls.size === 1 ? '' : 's'} in flight  —  type to send, /cancel-all to abort`
      : currentStep
        ? currentStep
        : undefined;

  return (
    <Box flexDirection="column" minHeight={10}>
      <Box borderStyle="round" borderColor="blue" paddingX={1} marginBottom={1}>
        <Text bold color="blue"> captain </Text>
        <Text dimColor> {'\u2014'} multi-agent coding crew through conversation</Text>
      </Box>

      <ConversationView messages={messages} />

      {!legacyMode && inFlightToolCalls.size > 0 && (
        <Box flexDirection="column" marginY={1}>
          {Array.from(inFlightToolCalls.values()).map((call) => (
            <Box key={call.toolCallId}>
              <Text color="yellow">{'\u25CF '}</Text>
              <Text dimColor>
                {call.toolName} ({call.toolCallId}
                {call.latestChunk ? `): ${call.latestChunk.slice(0, 60)}` : ')'}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {legacyMode && agents.length > 0 && (
        <Box marginY={1}>
          <AgentStatus agents={agents} />
        </Box>
      )}

      <Box marginTop={1}>
        <PromptInput
          onSubmit={handleSubmit}
          disabled={false}
          statusText={statusText}
        />
      </Box>
    </Box>
  );
}
