import { Pool } from "pg";

import type { CoordinatorConfig } from "../config/index.js";
import { InMemoryJobStore, type JobStore } from "../jobs/store.js";
import {
  ClientRegistry,
  type ClientRegistryStore,
} from "../registry/clientStore.js";
import { WorkerRegistry, type WorkerRegistryStore } from "../registry/store.js";
import {
  migrateCoordinatorPostgres,
  PostgresClientRegistry,
  PostgresJobStore,
  PostgresWorkerRegistry,
} from "./postgresStores.js";

export interface CoordinatorStores {
  jobs: JobStore;
  workers: WorkerRegistryStore;
  clients: ClientRegistryStore;
  close(): Promise<void>;
}

export async function createCoordinatorStores(
  config: CoordinatorConfig,
): Promise<CoordinatorStores> {
  if (config.persistenceDriver === "memory") {
    return {
      jobs: new InMemoryJobStore(),
      workers: new WorkerRegistry(),
      clients: new ClientRegistry(),
      close: async () => undefined,
    };
  }

  if (!config.postgresUrl) {
    throw new Error("POSTGRES_URL is required when COORDINATOR_PERSISTENCE=postgres");
  }

  const pool = new Pool({
    connectionString: config.postgresUrl,
    max: config.postgresMaxConnections,
    ssl: config.postgresSsl ? { rejectUnauthorized: false } : undefined,
  });

  await migrateCoordinatorPostgres(pool);

  return {
    jobs: new PostgresJobStore(pool),
    workers: new PostgresWorkerRegistry(pool),
    clients: new PostgresClientRegistry(pool),
    close: () => pool.end(),
  };
}
