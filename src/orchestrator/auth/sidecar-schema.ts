import { z } from 'zod';

export const RUN_AUTH_SIDECAR_FILENAME = '.auth.json';
export const WORKER_READY_FILENAME = '.worker-ready.json';

export const runAuthSidecarSchema = z.object({
  schema_version: z.literal(1),
  run_id: z.string().min(1),
  agent_id: z.string().min(1),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  repo_root: z.string().min(1),
  repo_hash: z.string().regex(/^[0-9a-f]{12}$/),
  captain_pid: z.number().int().positive(),
  captain_serve_instance: z.string().min(1),
  issued_at: z.string().datetime({ offset: true }),
  revoked: z.boolean(),
  revoked_at: z.string().datetime({ offset: true }).optional(),
});

export type RunAuthSidecar = z.infer<typeof runAuthSidecarSchema>;

export const workerReadyMarkerSchema = z.object({
  schema_version: z.literal(1),
  server_pid: z.number().int().positive(),
  server_instance: z.string().min(1),
  started_at: z.string().datetime({ offset: true }),
  registered_tools: z.array(z.string()),
});

export type WorkerReadyMarker = z.infer<typeof workerReadyMarkerSchema>;

export interface DispatchMcpEnv {
  readonly CREW_RUN_ID: string;
  readonly CREW_RUN_TOKEN: string;
}

export type WorkerReadyStatus =
  | {
      readonly status: 'pending';
    }
  | {
      readonly status: 'ready';
      readonly markerObservedAt: string;
      readonly markerServerPid: number;
      readonly markerServerInstance: string;
    }
  | {
      readonly status: 'timeout' | 'absent';
    };
