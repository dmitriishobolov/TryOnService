import type { TryOnJobResult } from "../../shared/contracts/index.js";
import type { TryOnModelProvider } from "../config/index.js";
import { genlookTryOnAdapter } from "./genlook/index.js";
import { runMockTryOnModel } from "./mock/index.js";
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
  ].map((adapter) => [adapter.provider, adapter]),
);

export function runSelectedTryOnModel(
  input: TryOnModelInput,
): Promise<TryOnJobResult> {
  const adapter = adapters.get(input.config.tryOnModelProvider);

  if (!adapter) {
    throw new Error(`Unsupported TryOn model provider: ${input.config.tryOnModelProvider}`);
  }

  return adapter.run(input);
}
