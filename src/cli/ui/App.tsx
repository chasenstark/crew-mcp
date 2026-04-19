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

  // `runnerActive` tracks whether pipeline.run() is currently executing — i.e.,
  // whether the session-loop is consuming events. Decoupled from session
  // message count: a persisted session has messages but no live loop. The
  // first submit in a UI mount always kicks off pipeline.run so the loop
  // has a driver; subsequent submits during an active run just append user
  // messages and let the loop pick them up.
  const [runnerActive, setRunnerActive] = useState(false);

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
      setRunnerActive(false);
      if (legacyMode) {
        setLegacyIsRunning(false);
        setLegacyWaitingForInput(false);
      }
    });

    // N5: legacy 'ask_user' listener removed — pipeline.ts throws on
    // ask_user decisions (M1.5-11) and JudgmentRunner's legacy path also
    // fails loudly if session/dispatcher aren't wired. Nothing emits the
    // event anymore.

    pipeline.on('error', (error) => {
      addMessage('system', `Error: ${error.message}`);
      setCurrentStep(null);
      setRunnerActive(false);
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
        // Linear mode (Pipeline without session/dispatcher) is M3-scope.
        // Post-M1.5-11 we still compile App without session for tests, but
        // run behavior is simple: submit starts pipeline.run once, further
        // submits are ignored with a note.
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

      // M1.5 path: emit a user_message session event. If the runner is
      // already active (pipeline.run in flight), the session-loop picks up
      // the event automatically. Otherwise we need to kick off pipeline.run —
      // this covers both cold-start (fresh session) and continuation (a
      // persisted session whose prior pipeline.run already completed).
      addMessage('user', input);
      if (runnerActive) {
        // Session-loop is live; just append. It'll see the event and
        // schedule a fresh captain turn.
        session!.appendUserMessage(input);
        return;
      }
      // Start a new workflow run. The runner will seed the session with the
      // user_message if it's empty; if it's a continuation, we append first
      // so the incoming user message is preserved even if the runner's
      // seed-guard skips.
      session!.appendUserMessage(input);
      setRunnerActive(true);
      pipeline.run(input).catch((err) => {
        addMessage('system', `Pipeline error: ${err instanceof Error ? err.message : String(err)}`);
        setRunnerActive(false);
      });
    },
    [pipeline, session, dispatcher, addMessage, finalizeStream, legacyMode, legacyIsRunning, legacyWaitingForInput, sessionBusy, runnerActive],
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
