import type {
  TryOnJobResult,
  TryOnModelProvider,
} from "../../shared/contracts/index.js";
import { genlookTryOnAdapter } from "./genlook/index.js";
import { runMockTryOnModel } from "./mock/index.js";
import { openAiTryOnAdapter } from "./openai/index.js";
import { pixelcutTryOnAdapter } from "./pixelcut/index.js";
import { prunaTryOnAdapter } from "./pruna/index.js";
import { tryOnCloudAdapter } from "./tryoncloud/index.js";
import type { TryOnModelAdapter, TryOnModelInput } from "./types.js";
import { wearfitsTryOnAdapter } from "./wearfits/index.js";

const mockTryOnAdapter: TryOnModelAdapter = {
  provider: "mock",
  displayName: "Mock",
  run: ({ config, signal }) =>
    runMockTryOnModel(config.mockProcessingDelayMs, signal),
};

const adapters = new Map<TryOnModelProvider, TryOnModelAdapter>(
  [
    mockTryOnAdapter,
    prunaTryOnAdapter,
    pixelcutTryOnAdapter,
    tryOnCloudAdapter,
    genlookTryOnAdapter,
    wearfitsTryOnAdapter,
    openAiTryOnAdapter,
  ].map((adapter) => [adapter.provider, adapter]),
);

export function runSelectedTryOnModel(
  input: TryOnModelInput,
): Promise<TryOnJobResult> {
  const provider = resolveRequestedProvider(input);
  const adapter = adapters.get(provider);

  if (!adapter) {
    throw new Error(`Unsupported TryOn model provider: ${provider}`);
  }

  return adapter.run(input);
}

function resolveRequestedProvider(input: TryOnModelInput): TryOnModelProvider {
  return input.job.payload.model?.provider ?? "mock";
}
