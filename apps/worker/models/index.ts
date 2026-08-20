import type { TryOnJobResult } from "../../shared/contracts/index.js";
import type { TryOnModelProvider } from "../config/index.js";
import { genlookTryOnAdapter } from "./genlookTryOnModel.js";
import { runMockTryOnModel } from "./mockTryOnModel.js";
import { pixelcutTryOnAdapter } from "./pixelcutTryOnModel.js";
import { prunaTryOnAdapter } from "./prunaTryOnModel.js";
import { tryOnCloudAdapter } from "./tryOnCloudModel.js";
import type { TryOnModelAdapter, TryOnModelInput } from "./types.js";
import { wearfitsTryOnAdapter } from "./wearfitsTryOnModel.js";

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
