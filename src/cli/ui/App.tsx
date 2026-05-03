import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp } from 'ink';
import { ConversationView, type ChatMessage } from './ConversationView.js';
import { PromptInput } from './PromptInput.js';
import { handleConfigSlashCommand } from './config/command-handler.js';
import { handlePresetSlashCommand } from './preset/command-handler.js';
import type { CrewRunner } from '../../captain/runner.js';
import type { CaptainSession } from '../../captain/session.js';
import type { ToolDispatcher } from '../../captain/tool-dispatcher.js';
import type { FullConfig } from '../../workflow/types.js';
import { formatStepComplete, formatStepStart, getStepLabel } from '../step-status.js';
import { logger } from '../../utils/logger.js';

interface InFlightToolCall {
  toolCallId: string;
  toolName: string;
  startedAt: number;
}

interface Props {
  pipeline: CrewRunner;
  session: CaptainSession;
  dispatcher: ToolDispatcher;
  startupHealthCheck?: () => Promise<void>;
  /**
   * Loaded config. Required for `/preset` support (the handler reads
   * `config.presets` + `config.captain.preset`). Optional at the type
   * level so legacy callers that don't need /preset can still construct
   * App without breaking — but `/preset` is a no-op in that case.
   */
  config?: FullConfig;
  initialPrompt?: string;
}

export function App({ pipeline, session, dispatcher, startupHealthCheck, config, initialPrompt }: Props) {
  useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [startupState, setStartupState] = useState<'ready' | 'checking' | 'failed'>(
    startupHealthCheck ? 'checking' : 'ready',
  );

  // inFlightToolCalls drives the session-busy indicator. The captain turn
  // accepts user_message events at any time, so the PromptInput is never
  // disabled regardless of in-flight tool calls.
  const [inFlightToolCalls, setInFlightToolCalls] = useState<Map<string, InFlightToolCall>>(new Map());
  const inFlightToolCallsRef = useRef<Map<string, InFlightToolCall>>(new Map());

  // `runnerActive` tracks whether pipeline.run() is currently executing — i.e.,
  // whether the session-loop is consuming events. Decoupled from session
  // message count: a persisted session has messages but no live loop. The
  // first submit in a UI mount always kicks off pipeline.run so the loop
  // has a driver; subsequent submits during an active run just append user
  // messages and let the loop pick them up.
  const [runnerActive, setRunnerActive] = useState(false);

  const addMessage = useCallback((role: ChatMessage['role'], content: string) => {
    setMessages((prev) => [...prev, { role, content }]);
  }, []);

  useEffect(() => {
    if (!startupHealthCheck) {
      setStartupState('ready');
      return;
    }

    let disposed = false;
    logger.info('Interactive startup checks started');
    setStartupState('checking');

    startupHealthCheck()
      .then(() => {
        if (disposed) return;
        logger.info('Interactive startup checks completed');
        setStartupState('ready');
      })
      .catch((error: unknown) => {
        if (disposed) return;
        logger.error('Interactive startup checks failed', error);
        const message = error instanceof Error ? error.message : String(error);
        setStartupState('failed');
        addMessage('system', message);
      });

    return () => {
      disposed = true;
    };
  }, [startupHealthCheck, addMessage]);

  useEffect(() => {
    pipeline.on('step:start', (step, data) => {
      setCurrentStep(getStepLabel(step));
      logger.info(`Step start [${step}] ${formatStepStart(step, data)}`);
    });

    pipeline.on('step:complete', (step, data) => {
      logger.info(`Step done [${step}] ${formatStepComplete(step, data)}`);
      setCurrentStep(null);
    });

    pipeline.on('report', (message) => {
      logger.info('Workflow report emitted');
      addMessage('assistant', message);
      setCurrentStep(null);
      setRunnerActive(false);
    });

    pipeline.on('error', (error) => {
      logger.error('Workflow error', error);
      addMessage('system', `Error: ${error.message}`);
      setCurrentStep(null);
      setRunnerActive(false);
    });

    return () => {
      pipeline.removeAllListeners();
    };
  }, [pipeline, addMessage]);

  // Wire dispatcher events to inFlightToolCalls state.
  useEffect(() => {
    const handles = [
      dispatcher.onEvent('run:start', (info) => {
        logger.info(`Tool call started: ${info.toolName} ${info.runId ?? info.toolCallId}`);
        const next = new Map(inFlightToolCallsRef.current);
        next.set(info.toolCallId, {
          toolCallId: info.toolCallId,
          toolName: info.toolName,
          startedAt: Date.now(),
        });
        inFlightToolCallsRef.current = next;
        setInFlightToolCalls(next);
      }),
      dispatcher.onEvent('run:complete', (info) => {
        logger.info(`Tool call completed: ${info.toolName} ${info.runId ?? info.toolCallId}`);
        const next = new Map(inFlightToolCallsRef.current);
        next.delete(info.toolCallId);
        inFlightToolCallsRef.current = next;
        setInFlightToolCalls(next);
      }),
      dispatcher.onEvent('run:failed', (info) => {
        logger.error(`Tool call failed: ${info.toolName}`, info.error);
        const next = new Map(inFlightToolCallsRef.current);
        next.delete(info.toolCallId);
        inFlightToolCallsRef.current = next;
        setInFlightToolCalls(next);
      }),
      dispatcher.onEvent('run:cancelled', (info) => {
        logger.warn(`Tool call cancelled: ${info.toolName}`, info.reason);
        const next = new Map(inFlightToolCallsRef.current);
        next.delete(info.toolCallId);
        inFlightToolCallsRef.current = next;
        setInFlightToolCalls(next);
      }),
    ];
    return () => {
      for (const h of handles) h.dispose();
    };
  }, [dispatcher]);

  const sessionBusy = inFlightToolCalls.size > 0;

  const handleSubmit = useCallback(
    (input: string) => {
      if (startupState !== 'ready') {
        return;
      }

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

      // /preset routes BETWEEN /config and /cancel. Placement matters:
      // placing it before /config would shadow any future `/config preset-*`
      // paths; placing it after /cancel would let `/cancel --preset` prefix-
      // match. The explicit ordering here prevents both regressions.
      // Preset switching is safe mid-run (prompt material only; NOT
      // tool-schema material), so unlike /config it does not gate on
      // sessionBusy.
      if (input.startsWith('/preset')) {
        if (!config) {
          // Production paths always thread `config` via run.ts. This branch
          // only fires under test harnesses that mount App without config —
          // surface a user-facing message rather than a developer telemetry
          // string if that ever happens in the wild.
          addMessage(
            'system',
            'Preset commands are unavailable right now (configuration did not load). Try restarting, or run `crew config show` to inspect.',
          );
          return;
        }
        try {
          const response = handlePresetSlashCommand(input, { session, config });
          if (response !== null) {
            addMessage('system', response);
            return;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          addMessage('system', `Preset error: ${message}`);
          return;
        }
      }

      // Slash commands for cancellation.
      if (input.startsWith('/cancel')) {
        const rest = input.slice('/cancel'.length).trim();
        if (rest === '-all' || rest === 'all') {
          const n = dispatcher.cancelAll('user /cancel-all');
          addMessage('system', `Cancelled ${n} in-flight tool call${n === 1 ? '' : 's'}.`);
          return;
        }
        if (!rest || rest === '') {
          pipeline.cancel('Cancelled by user from interactive session');
          setCurrentStep(null);
          addMessage('system', 'Cancelled. Session terminated; workflow state saved as interrupted.');
          return;
        }
        // /cancel <id>
        const cancelled = dispatcher.cancel(rest, 'user /cancel');
        addMessage(
          'system',
          cancelled
            ? `Cancelled tool call ${rest}.`
            : `No in-flight tool call with id ${rest}.`,
        );
        return;
      }

      // Emit a user_message session event. If the runner is already active
      // (pipeline.run in flight), the session-loop picks up the event
      // automatically. Otherwise we kick off pipeline.run — this covers both
      // cold-start (fresh session) and continuation (a persisted session
      // whose prior pipeline.run already completed).
      addMessage('user', input);
      if (runnerActive) {
        session.appendUserMessage(input);
        return;
      }
      // Start a new workflow run. The runner seeds the session with the
      // user_message if it's empty; on continuation we append first so the
      // incoming user message is preserved even if the runner's seed-guard
      // skips.
      session.appendUserMessage(input);
      setRunnerActive(true);
      pipeline.run(input).catch((err) => {
        addMessage('system', `Run error: ${err instanceof Error ? err.message : String(err)}`);
        setRunnerActive(false);
      });
    },
    [pipeline, session, dispatcher, config, addMessage, sessionBusy, runnerActive, startupState],
  );

  useEffect(() => {
    if (initialPrompt) {
      handleSubmit(initialPrompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  const startupBusy = startupState === 'checking';
  const startupFailed = startupState === 'failed';
  const statusText = startupBusy
    ? 'Checking adapter status...'
    : startupFailed
      ? 'Startup checks failed. Run `crew status` to inspect and authenticate providers.'
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

      {inFlightToolCalls.size > 0 && (
        <Box flexDirection="column" marginY={1}>
          {Array.from(inFlightToolCalls.values()).map((call) => (
            <Box key={call.toolCallId}>
              <Text color="yellow">{'\u25CF '}</Text>
              <Text dimColor>
                {call.toolName} ({call.toolCallId})
              </Text>
            </Box>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <PromptInput
          onSubmit={handleSubmit}
          disabled={startupBusy || startupFailed}
          statusText={statusText}
        />
      </Box>
    </Box>
  );
}
