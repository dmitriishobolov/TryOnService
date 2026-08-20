import { Pool } from "pg";

import type { CoordinatorConfig } from "../config/index.js";
import { InMemoryJobStore, type JobStore } from "../jobs/store.js";
import {
  ClientRegistry,
  type ClientRegistryStore,
} from "../registry/clientStore.js";
import { WorkerRegistry, type WorkerRegistryStore } from "../registry/store.js";
import {
  StorageRegistry,
  type StorageRegistryStore,
} from "../registry/storageStore.js";
import {
  InMemorySecurityAuditStore,
  type SecurityAuditStore,
} from "../security/auditStore.js";
import {
  InMemoryRegistrationBanStore,
  type RegistrationBanStore,
} from "../security/registrationBanStore.js";
import {
  migrateCoordinatorPostgres,
  PostgresClientRegistry,
  PostgresJobStore,
  PostgresRegistrationBanStore,
  PostgresSecurityAuditStore,
  PostgresStorageRegistry,
  PostgresWorkerRegistry,
} from "./postgresStores.js";

export interface CoordinatorStores {
  jobs: JobStore;
  workers: WorkerRegistryStore;
  clients: ClientRegistryStore;
  storageNodes: StorageRegistryStore;
  audit: SecurityAuditStore;
  registrationBans: RegistrationBanStore;
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
      storageNodes: new StorageRegistry(),
      audit: new InMemorySecurityAuditStore(),
      registrationBans: new InMemoryRegistrationBanStore(),
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
    storageNodes: new PostgresStorageRegistry(pool),
    audit: new PostgresSecurityAuditStore(pool),
    registrationBans: new PostgresRegistrationBanStore(pool),
    close: () => pool.end(),
  };
}
