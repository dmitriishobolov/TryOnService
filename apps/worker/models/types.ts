import type {
  StorageObjectRef,
  TryOnJobResult,
  TryOnModelProvider,
  WorkerJobRequest,
} from "../../shared/contracts/index.js";
import type { CoordinatorClient } from "../api/coordinatorClient.js";
import type { WorkerConfig } from "../config/index.js";

export interface TryOnModelInput {
  job: WorkerJobRequest;
  config: WorkerConfig;
  coordinator: CoordinatorClient;
  signal?: AbortSignal;
}

export interface TryOnModelAdapter {
  provider: TryOnModelProvider;
  displayName: string;
  run(input: TryOnModelInput): Promise<TryOnJobResult>;
}

export interface TryOnInputFiles {
  person: StorageObjectRef;
  garment: StorageObjectRef;
}

export interface DownloadedImage {
  buffer: Buffer;
  contentType: string;
  filename: string;
}
