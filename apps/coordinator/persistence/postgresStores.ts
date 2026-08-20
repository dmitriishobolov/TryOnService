import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import type {
  ClientHeartbeatRequest,
  ClientRegistrationRequest,
  ClientType,
  CreateTryOnJobRequest,
  JobProgressUpdateRequest,
  JobResultUpdateRequest,
  JobStatus,
  RegisteredClient,
  RegisteredStorageNode,
  RegisteredWorker,
  StorageHeartbeatRequest,
  StorageRegistrationRequest,
  TryOnJob,
  WorkerCapability,
  WorkerHeartbeatRequest,
  WorkerRegistrationRequest,
  WorkerStatus,
} from "../../shared/contracts/index.js";
import type { JobStore } from "../jobs/store.js";
import type { ClientRegistryStore } from "../registry/clientStore.js";
import type { StorageRegistryStore } from "../registry/storageStore.js";
import type { WorkerRegistryStore } from "../registry/store.js";

interface JobRow {
  id: string;
  status: string;
  source_client_id: string;
  client: unknown;
  payload: unknown;
  callback_url: string | null;
  assigned_worker_id: string | null;
  assigned_at: Date | string | null;
  dispatch_token_expires_at: Date | string | null;
  result: unknown | null;
  error: unknown | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface WorkerRow {
  worker_id: string;
  base_url: string;
  status: string;
  capacity: number;
  running_jobs: number;
  capabilities: unknown;
  registered_at: Date | string;
  last_heartbeat_at: Date | string;
}

interface ClientRow {
  client_id: string;
  type: string;
  base_url: string;
  callback_url: string;
  status: string;
  registered_at: Date | string;
  last_heartbeat_at: Date | string;
}

interface StorageNodeRow {
  storage_id: string;
  base_url: string;
  driver: string;
  status: string;
  used_bytes: string | number | null;
  capacity_bytes: string | number | null;
  registered_at: Date | string;
  last_heartbeat_at: Date | string;
}

export async function migrateCoordinatorPostgres(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tryon_jobs (
      id uuid PRIMARY KEY,
      status text NOT NULL,
      source_client_id text NOT NULL,
      client jsonb NOT NULL,
      payload jsonb NOT NULL,
      callback_url text,
      assigned_worker_id text,
      assigned_at timestamptz,
      dispatch_token_expires_at timestamptz,
      result jsonb,
      error jsonb,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tryon_jobs_status
      ON tryon_jobs (status)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tryon_jobs_worker
      ON tryon_jobs (assigned_worker_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tryon_jobs_source_client
      ON tryon_jobs (source_client_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tryon_workers (
      worker_id text PRIMARY KEY,
      base_url text NOT NULL,
      status text NOT NULL,
      capacity integer NOT NULL,
      running_jobs integer NOT NULL,
      capabilities jsonb NOT NULL,
      registered_at timestamptz NOT NULL,
      last_heartbeat_at timestamptz NOT NULL
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tryon_workers_fresh_capacity
      ON tryon_workers (status, last_heartbeat_at, running_jobs, capacity)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tryon_clients (
      client_id text PRIMARY KEY,
      type text NOT NULL,
      base_url text NOT NULL,
      callback_url text NOT NULL,
      status text NOT NULL,
      registered_at timestamptz NOT NULL,
      last_heartbeat_at timestamptz NOT NULL
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tryon_clients_status_heartbeat
      ON tryon_clients (status, last_heartbeat_at)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tryon_storage_objects (
      object_key text PRIMARY KEY,
      driver text NOT NULL,
      bucket text,
      content_type text,
      size_bytes bigint,
      checksum_sha256 text,
      storage_id text,
      url text,
      owner_job_id uuid REFERENCES tryon_jobs(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    ALTER TABLE tryon_storage_objects
      ADD COLUMN IF NOT EXISTS storage_id text
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tryon_storage_nodes (
      storage_id text PRIMARY KEY,
      base_url text NOT NULL,
      driver text NOT NULL,
      status text NOT NULL,
      used_bytes bigint,
      capacity_bytes bigint,
      registered_at timestamptz NOT NULL,
      last_heartbeat_at timestamptz NOT NULL
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tryon_storage_nodes_status_heartbeat
      ON tryon_storage_nodes (status, last_heartbeat_at)
  `);
}

export class PostgresJobStore implements JobStore {
  constructor(private readonly pool: Pool) {}

  async create(request: CreateTryOnJobRequest): Promise<TryOnJob> {
    const now = new Date().toISOString();
    const job: TryOnJob = {
      id: randomUUID(),
      status: "queued",
      sourceClientId: request.sourceClientId,
      client: request.client,
      payload: request.payload,
      callbackUrl: request.callbackUrl,
      createdAt: now,
      updatedAt: now,
    };

    return this.insert(job);
  }

  async createAssigned(
    request: CreateTryOnJobRequest,
    workerId: string,
    dispatchTokenExpiresAt: string,
  ): Promise<TryOnJob> {
    const now = new Date().toISOString();
    const job: TryOnJob = {
      id: randomUUID(),
      status: "assigned",
      sourceClientId: request.sourceClientId,
      client: request.client,
      payload: request.payload,
      callbackUrl: request.callbackUrl,
      assignedWorkerId: workerId,
      assignedAt: now,
      dispatchTokenExpiresAt,
      createdAt: now,
      updatedAt: now,
    };

    return this.insert(job);
  }

  async get(jobId: string): Promise<TryOnJob | undefined> {
    const result = await this.pool.query<JobRow>(
      "SELECT * FROM tryon_jobs WHERE id = $1",
      [jobId],
    );

    return result.rows[0] ? mapJobRow(result.rows[0]) : undefined;
  }

  async list(): Promise<TryOnJob[]> {
    const result = await this.pool.query<JobRow>(
      "SELECT * FROM tryon_jobs ORDER BY created_at DESC",
    );

    return result.rows.map(mapJobRow);
  }

  async findQueued(): Promise<TryOnJob[]> {
    const result = await this.pool.query<JobRow>(
      "SELECT * FROM tryon_jobs WHERE status = $1 ORDER BY created_at ASC",
      ["queued"],
    );

    return result.rows.map(mapJobRow);
  }

  async findExpiredAssignments(timeoutMs: number): Promise<TryOnJob[]> {
    const cutoff = new Date(Date.now() - timeoutMs).toISOString();
    const result = await this.pool.query<JobRow>(
      `
        SELECT *
        FROM tryon_jobs
        WHERE status = $1
          AND COALESCE(assigned_at, updated_at) < $2
        ORDER BY updated_at ASC
      `,
      ["assigned", cutoff],
    );

    return result.rows.map(mapJobRow);
  }

  async findActiveByWorker(workerId: string): Promise<TryOnJob[]> {
    const result = await this.pool.query<JobRow>(
      `
        SELECT *
        FROM tryon_jobs
        WHERE assigned_worker_id = $1
          AND status NOT IN ('succeeded', 'failed', 'cancelled')
        ORDER BY updated_at ASC
      `,
      [workerId],
    );

    return result.rows.map(mapJobRow);
  }

  async findActiveBySourceClient(clientId: string): Promise<TryOnJob[]> {
    const result = await this.pool.query<JobRow>(
      `
        SELECT *
        FROM tryon_jobs
        WHERE source_client_id = $1
          AND status NOT IN ('succeeded', 'failed', 'cancelled')
        ORDER BY updated_at ASC
      `,
      [clientId],
    );

    return result.rows.map(mapJobRow);
  }

  async markAssigned(
    jobId: string,
    workerId: string,
  ): Promise<TryOnJob | undefined> {
    const now = new Date().toISOString();
    const result = await this.pool.query<JobRow>(
      `
        UPDATE tryon_jobs
        SET status = 'assigned',
            assigned_worker_id = $2,
            assigned_at = $3,
            updated_at = $3
        WHERE id = $1
          AND status = 'queued'
        RETURNING *
      `,
      [jobId, workerId, now],
    );

    return result.rows[0] ? mapJobRow(result.rows[0]) : undefined;
  }

  async markRunning(
    update: JobProgressUpdateRequest,
  ): Promise<TryOnJob | undefined> {
    const now = new Date().toISOString();
    const result = await this.pool.query<JobRow>(
      `
        UPDATE tryon_jobs
        SET status = 'running',
            updated_at = $2
        WHERE id = $1
          AND status NOT IN ('succeeded', 'failed', 'cancelled')
        RETURNING *
      `,
      [update.jobId, now],
    );

    return result.rows[0] ? mapJobRow(result.rows[0]) : undefined;
  }

  async markResult(
    update: JobResultUpdateRequest,
  ): Promise<TryOnJob | undefined> {
    const current = await this.get(update.jobId);

    if (!current) {
      return undefined;
    }

    if (
      current.status === "succeeded" ||
      current.status === "failed" ||
      current.status === "cancelled"
    ) {
      return current;
    }

    const now = new Date().toISOString();
    const result = await this.pool.query<JobRow>(
      `
        UPDATE tryon_jobs
        SET status = $2,
            result = $3,
            error = $4,
            updated_at = $5
        WHERE id = $1
        RETURNING *
      `,
      [
        update.jobId,
        update.status,
        update.result ? JSON.stringify(update.result) : null,
        update.error ? JSON.stringify(update.error) : null,
        now,
      ],
    );

    return result.rows[0] ? mapJobRow(result.rows[0]) : undefined;
  }

  async requeue(jobId: string): Promise<TryOnJob | undefined> {
    const now = new Date().toISOString();
    const result = await this.pool.query<JobRow>(
      `
        UPDATE tryon_jobs
        SET status = 'queued',
            assigned_worker_id = NULL,
            assigned_at = NULL,
            dispatch_token_expires_at = NULL,
            updated_at = $2
        WHERE id = $1
        RETURNING *
      `,
      [jobId, now],
    );

    return result.rows[0] ? mapJobRow(result.rows[0]) : undefined;
  }

  async markAssignmentExpired(jobId: string): Promise<TryOnJob | undefined> {
    return this.markFailed(jobId, {
      code: "assignment_expired",
      message: "Worker assignment expired before direct client dispatch",
      retryable: true,
    });
  }

  async markFailed(
    jobId: string,
    error: TryOnJob["error"],
  ): Promise<TryOnJob | undefined> {
    const current = await this.get(jobId);

    if (
      !current ||
      current.status === "succeeded" ||
      current.status === "failed" ||
      current.status === "cancelled"
    ) {
      return current;
    }

    const now = new Date().toISOString();
    const result = await this.pool.query<JobRow>(
      `
        UPDATE tryon_jobs
        SET status = 'failed',
            error = $2,
            updated_at = $3
        WHERE id = $1
        RETURNING *
      `,
      [jobId, error ? JSON.stringify(error) : null, now],
    );

    return result.rows[0] ? mapJobRow(result.rows[0]) : undefined;
  }

  private async insert(job: TryOnJob): Promise<TryOnJob> {
    const result = await this.pool.query<JobRow>(
      `
        INSERT INTO tryon_jobs (
          id,
          status,
          source_client_id,
          client,
          payload,
          callback_url,
          assigned_worker_id,
          assigned_at,
          dispatch_token_expires_at,
          result,
          error,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *
      `,
      [
        job.id,
        job.status,
        job.sourceClientId,
        JSON.stringify(job.client),
        JSON.stringify(job.payload),
        job.callbackUrl ?? null,
        job.assignedWorkerId ?? null,
        job.assignedAt ?? null,
        job.dispatchTokenExpiresAt ?? null,
        job.result ? JSON.stringify(job.result) : null,
        job.error ? JSON.stringify(job.error) : null,
        job.createdAt,
        job.updatedAt,
      ],
    );

    return mapJobRow(result.rows[0]);
  }
}

export class PostgresWorkerRegistry implements WorkerRegistryStore {
  constructor(private readonly pool: Pool) {}

  async register(
    request: WorkerRegistrationRequest,
    resolvedBaseUrl: string,
  ): Promise<RegisteredWorker> {
    const now = new Date().toISOString();
    const result = await this.pool.query<WorkerRow>(
      `
        INSERT INTO tryon_workers (
          worker_id,
          base_url,
          status,
          capacity,
          running_jobs,
          capabilities,
          registered_at,
          last_heartbeat_at
        )
        VALUES ($1, $2, 'ready', $3, 0, $4, $5, $5)
        ON CONFLICT (worker_id) DO UPDATE
        SET base_url = EXCLUDED.base_url,
            status = 'ready',
            capacity = EXCLUDED.capacity,
            capabilities = EXCLUDED.capabilities,
            last_heartbeat_at = EXCLUDED.last_heartbeat_at
        RETURNING *
      `,
      [
        request.workerId,
        resolvedBaseUrl.replace(/\/$/, ""),
        request.capacity,
        JSON.stringify(request.capabilities),
        now,
      ],
    );

    return mapWorkerRow(result.rows[0]);
  }

  async heartbeat(
    request: WorkerHeartbeatRequest,
  ): Promise<RegisteredWorker | undefined> {
    const now = new Date().toISOString();
    const result = await this.pool.query<WorkerRow>(
      `
        UPDATE tryon_workers
        SET running_jobs = GREATEST(running_jobs, $2),
            capacity = $3,
            status = CASE
              WHEN $4 = 'offline' THEN 'offline'
              WHEN GREATEST(running_jobs, $2) >= $3 THEN 'busy'
              ELSE $4
            END,
            last_heartbeat_at = $5
        WHERE worker_id = $1
        RETURNING *
      `,
      [
        request.workerId,
        request.runningJobs,
        request.capacity,
        request.status,
        now,
      ],
    );

    return result.rows[0] ? mapWorkerRow(result.rows[0]) : undefined;
  }

  async reserve(workerId: string): Promise<RegisteredWorker | undefined> {
    const result = await this.pool.query<WorkerRow>(
      `
        UPDATE tryon_workers
        SET running_jobs = running_jobs + 1,
            status = CASE
              WHEN running_jobs + 1 >= capacity THEN 'busy'
              ELSE 'ready'
            END
        WHERE worker_id = $1
          AND running_jobs < capacity
          AND status <> 'offline'
        RETURNING *
      `,
      [workerId],
    );

    return result.rows[0] ? mapWorkerRow(result.rows[0]) : undefined;
  }

  async release(workerId: string): Promise<RegisteredWorker | undefined> {
    const result = await this.pool.query<WorkerRow>(
      `
        UPDATE tryon_workers
        SET running_jobs = GREATEST(0, running_jobs - 1),
            status = CASE
              WHEN GREATEST(0, running_jobs - 1) >= capacity THEN 'busy'
              ELSE 'ready'
            END
        WHERE worker_id = $1
        RETURNING *
      `,
      [workerId],
    );

    return result.rows[0] ? mapWorkerRow(result.rows[0]) : undefined;
  }

  async markOffline(workerId: string): Promise<RegisteredWorker | undefined> {
    const result = await this.pool.query<WorkerRow>(
      `
        UPDATE tryon_workers
        SET status = 'offline',
            running_jobs = 0
        WHERE worker_id = $1
        RETURNING *
      `,
      [workerId],
    );

    return result.rows[0] ? mapWorkerRow(result.rows[0]) : undefined;
  }

  async list(): Promise<RegisteredWorker[]> {
    const result = await this.pool.query<WorkerRow>(
      "SELECT * FROM tryon_workers ORDER BY worker_id ASC",
    );

    return result.rows.map(mapWorkerRow);
  }

  async get(workerId: string): Promise<RegisteredWorker | undefined> {
    const result = await this.pool.query<WorkerRow>(
      "SELECT * FROM tryon_workers WHERE worker_id = $1",
      [workerId],
    );

    return result.rows[0] ? mapWorkerRow(result.rows[0]) : undefined;
  }

  async findAvailable(
    heartbeatTimeoutMs: number,
    requiredCapabilities: string[] = [],
  ): Promise<RegisteredWorker | undefined> {
    const cutoff = new Date(Date.now() - heartbeatTimeoutMs).toISOString();
    const result = await this.pool.query<WorkerRow>(
      `
        SELECT *
        FROM tryon_workers
        WHERE status <> 'offline'
          AND running_jobs < capacity
          AND last_heartbeat_at >= $1
        ORDER BY running_jobs ASC, last_heartbeat_at DESC
      `,
      [cutoff],
    );

    return result.rows.map(mapWorkerRow).find((worker) =>
      requiredCapabilities.every((required) =>
        worker.capabilities.some((capability) => capability.name === required),
      ),
    );
  }

  async markStaleWorkersOffline(
    heartbeatTimeoutMs: number,
  ): Promise<RegisteredWorker[]> {
    const cutoff = new Date(Date.now() - heartbeatTimeoutMs).toISOString();
    const result = await this.pool.query<WorkerRow>(
      `
        UPDATE tryon_workers
        SET status = 'offline',
            running_jobs = 0
        WHERE status <> 'offline'
          AND last_heartbeat_at < $1
        RETURNING *
      `,
      [cutoff],
    );

    return result.rows.map(mapWorkerRow);
  }
}

export class PostgresClientRegistry implements ClientRegistryStore {
  constructor(private readonly pool: Pool) {}

  async register(
    request: ClientRegistrationRequest,
    resolvedBaseUrl: string,
  ): Promise<RegisteredClient> {
    const now = new Date().toISOString();
    const baseUrl = resolvedBaseUrl.replace(/\/$/, "");
    const callbackUrl = `${baseUrl}${request.callbackPath}`;
    const result = await this.pool.query<ClientRow>(
      `
        INSERT INTO tryon_clients (
          client_id,
          type,
          base_url,
          callback_url,
          status,
          registered_at,
          last_heartbeat_at
        )
        VALUES ($1, $2, $3, $4, 'ready', $5, $5)
        ON CONFLICT (client_id) DO UPDATE
        SET type = EXCLUDED.type,
            base_url = EXCLUDED.base_url,
            callback_url = EXCLUDED.callback_url,
            status = 'ready',
            last_heartbeat_at = EXCLUDED.last_heartbeat_at
        RETURNING *
      `,
      [request.clientId, request.type, baseUrl, callbackUrl, now],
    );

    return mapClientRow(result.rows[0]);
  }

  async heartbeat(
    request: ClientHeartbeatRequest,
  ): Promise<RegisteredClient | undefined> {
    const now = new Date().toISOString();
    const result = await this.pool.query<ClientRow>(
      `
        UPDATE tryon_clients
        SET status = $2,
            last_heartbeat_at = $3
        WHERE client_id = $1
        RETURNING *
      `,
      [request.clientId, request.status, now],
    );

    return result.rows[0] ? mapClientRow(result.rows[0]) : undefined;
  }

  async get(clientId: string): Promise<RegisteredClient | undefined> {
    const result = await this.pool.query<ClientRow>(
      "SELECT * FROM tryon_clients WHERE client_id = $1",
      [clientId],
    );

    return result.rows[0] ? mapClientRow(result.rows[0]) : undefined;
  }

  async list(): Promise<RegisteredClient[]> {
    const result = await this.pool.query<ClientRow>(
      "SELECT * FROM tryon_clients ORDER BY client_id ASC",
    );

    return result.rows.map(mapClientRow);
  }

  async markOffline(clientId: string): Promise<RegisteredClient | undefined> {
    const result = await this.pool.query<ClientRow>(
      `
        UPDATE tryon_clients
        SET status = 'offline'
        WHERE client_id = $1
        RETURNING *
      `,
      [clientId],
    );

    return result.rows[0] ? mapClientRow(result.rows[0]) : undefined;
  }

  async markStaleClientsOffline(
    heartbeatTimeoutMs: number,
  ): Promise<RegisteredClient[]> {
    const cutoff = new Date(Date.now() - heartbeatTimeoutMs).toISOString();
    const result = await this.pool.query<ClientRow>(
      `
        UPDATE tryon_clients
        SET status = 'offline'
        WHERE status <> 'offline'
          AND last_heartbeat_at < $1
        RETURNING *
      `,
      [cutoff],
    );

    return result.rows.map(mapClientRow);
  }
}

export class PostgresStorageRegistry implements StorageRegistryStore {
  constructor(private readonly pool: Pool) {}

  async register(
    request: StorageRegistrationRequest,
    resolvedBaseUrl: string,
  ): Promise<RegisteredStorageNode> {
    const now = new Date().toISOString();
    const result = await this.pool.query<StorageNodeRow>(
      `
        INSERT INTO tryon_storage_nodes (
          storage_id,
          base_url,
          driver,
          status,
          used_bytes,
          capacity_bytes,
          registered_at,
          last_heartbeat_at
        )
        VALUES ($1, $2, $3, 'ready', NULL, $4, $5, $5)
        ON CONFLICT (storage_id) DO UPDATE
        SET base_url = EXCLUDED.base_url,
            driver = EXCLUDED.driver,
            status = 'ready',
            capacity_bytes = EXCLUDED.capacity_bytes,
            last_heartbeat_at = EXCLUDED.last_heartbeat_at
        RETURNING *
      `,
      [
        request.storageId,
        resolvedBaseUrl.replace(/\/$/, ""),
        request.driver,
        request.capacityBytes ?? null,
        now,
      ],
    );

    return mapStorageNodeRow(result.rows[0]);
  }

  async heartbeat(
    request: StorageHeartbeatRequest,
  ): Promise<RegisteredStorageNode | undefined> {
    const now = new Date().toISOString();
    const result = await this.pool.query<StorageNodeRow>(
      `
        UPDATE tryon_storage_nodes
        SET status = $2,
            used_bytes = COALESCE($3, used_bytes),
            capacity_bytes = COALESCE($4, capacity_bytes),
            last_heartbeat_at = $5
        WHERE storage_id = $1
        RETURNING *
      `,
      [
        request.storageId,
        request.status,
        request.usedBytes ?? null,
        request.capacityBytes ?? null,
        now,
      ],
    );

    return result.rows[0] ? mapStorageNodeRow(result.rows[0]) : undefined;
  }

  async markOffline(
    storageId: string,
  ): Promise<RegisteredStorageNode | undefined> {
    const result = await this.pool.query<StorageNodeRow>(
      `
        UPDATE tryon_storage_nodes
        SET status = 'offline'
        WHERE storage_id = $1
        RETURNING *
      `,
      [storageId],
    );

    return result.rows[0] ? mapStorageNodeRow(result.rows[0]) : undefined;
  }

  async list(): Promise<RegisteredStorageNode[]> {
    const result = await this.pool.query<StorageNodeRow>(
      "SELECT * FROM tryon_storage_nodes ORDER BY storage_id ASC",
    );

    return result.rows.map(mapStorageNodeRow);
  }

  async get(storageId: string): Promise<RegisteredStorageNode | undefined> {
    const result = await this.pool.query<StorageNodeRow>(
      "SELECT * FROM tryon_storage_nodes WHERE storage_id = $1",
      [storageId],
    );

    return result.rows[0] ? mapStorageNodeRow(result.rows[0]) : undefined;
  }

  async findAvailable(
    heartbeatTimeoutMs: number,
  ): Promise<RegisteredStorageNode | undefined> {
    const cutoff = new Date(Date.now() - heartbeatTimeoutMs).toISOString();
    const result = await this.pool.query<StorageNodeRow>(
      `
        SELECT *
        FROM tryon_storage_nodes
        WHERE status <> 'offline'
          AND last_heartbeat_at >= $1
          AND (capacity_bytes IS NULL OR used_bytes IS NULL OR used_bytes < capacity_bytes)
        ORDER BY last_heartbeat_at DESC
        LIMIT 1
      `,
      [cutoff],
    );

    return result.rows[0] ? mapStorageNodeRow(result.rows[0]) : undefined;
  }

  async markStaleStorageOffline(
    heartbeatTimeoutMs: number,
  ): Promise<RegisteredStorageNode[]> {
    const cutoff = new Date(Date.now() - heartbeatTimeoutMs).toISOString();
    const result = await this.pool.query<StorageNodeRow>(
      `
        UPDATE tryon_storage_nodes
        SET status = 'offline'
        WHERE status <> 'offline'
          AND last_heartbeat_at < $1
        RETURNING *
      `,
      [cutoff],
    );

    return result.rows.map(mapStorageNodeRow);
  }
}

function mapJobRow(row: JobRow): TryOnJob {
  return {
    id: row.id,
    status: row.status as JobStatus,
    sourceClientId: row.source_client_id,
    client: row.client as TryOnJob["client"],
    payload: row.payload as TryOnJob["payload"],
    callbackUrl: row.callback_url ?? undefined,
    assignedWorkerId: row.assigned_worker_id ?? undefined,
    assignedAt: isoOrUndefined(row.assigned_at),
    dispatchTokenExpiresAt: isoOrUndefined(row.dispatch_token_expires_at),
    result: (row.result as TryOnJob["result"]) ?? undefined,
    error: (row.error as TryOnJob["error"]) ?? undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapWorkerRow(row: WorkerRow): RegisteredWorker {
  return {
    workerId: row.worker_id,
    baseUrl: row.base_url,
    status: row.status as WorkerStatus,
    capacity: Number(row.capacity),
    runningJobs: Number(row.running_jobs),
    capabilities: row.capabilities as WorkerCapability[],
    registeredAt: toIsoString(row.registered_at),
    lastHeartbeatAt: toIsoString(row.last_heartbeat_at),
  };
}

function mapClientRow(row: ClientRow): RegisteredClient {
  return {
    clientId: row.client_id,
    type: row.type as ClientType,
    baseUrl: row.base_url,
    callbackUrl: row.callback_url,
    status: row.status as RegisteredClient["status"],
    registeredAt: toIsoString(row.registered_at),
    lastHeartbeatAt: toIsoString(row.last_heartbeat_at),
  };
}

function mapStorageNodeRow(row: StorageNodeRow): RegisteredStorageNode {
  return {
    storageId: row.storage_id,
    baseUrl: row.base_url,
    driver: row.driver as RegisteredStorageNode["driver"],
    status: row.status as RegisteredStorageNode["status"],
    usedBytes: row.used_bytes === null ? undefined : Number(row.used_bytes),
    capacityBytes:
      row.capacity_bytes === null ? undefined : Number(row.capacity_bytes),
    registeredAt: toIsoString(row.registered_at),
    lastHeartbeatAt: toIsoString(row.last_heartbeat_at),
  };
}

function isoOrUndefined(value: Date | string | null): string | undefined {
  return value ? toIsoString(value) : undefined;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
