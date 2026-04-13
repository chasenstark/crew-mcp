import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

export interface AgentInfo {
  name: string;
  status: 'running' | 'waiting' | 'done' | 'error';
  task?: string;
  startedAt?: number;
}

interface Props {
  agents: AgentInfo[];
}

export function AgentStatus({ agents }: Props) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const hasRunning = agents.some(a => a.status === 'running');
    if (!hasRunning) return;
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, [agents]);

  if (agents.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold> Agents </Text>
      {agents.map((agent) => {
        const icon = agent.status === 'running' ? '\u25CF' :
                     agent.status === 'done' ? '\u2713' :
                     agent.status === 'error' ? '\u2717' : '\u25CB';
        const color = agent.status === 'running' ? 'green' :
                      agent.status === 'done' ? 'green' :
                      agent.status === 'error' ? 'red' : 'gray';
        const elapsed = agent.startedAt
          ? formatElapsed(Date.now() - agent.startedAt)
          : '';

        return (
          <Box key={agent.name} gap={1}>
            <Text color={color}>{icon}</Text>
            <Text bold>{agent.name.padEnd(14)}</Text>
            <Text dimColor>{(agent.task ?? agent.status).padEnd(40)}</Text>
            {elapsed && <Text dimColor>{elapsed}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return minutes > 0 ? `${minutes}m${String(secs).padStart(2, '0')}s` : `${secs}s`;
}
