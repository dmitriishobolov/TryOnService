import { createLogger } from "../../shared/logger.js";
import type { CatalogIngestorConfig } from "../config/index.js";
import type { CatalogProvider } from "./types.js";
import type { GarmentCatalogPublisher } from "./storagePublisher.js";

const logger = createLogger("catalog-ingestor");

export class CatalogSyncRunner {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: CatalogIngestorConfig,
    private readonly providers: CatalogProvider[],
    private readonly publisher: GarmentCatalogPublisher,
  ) {}

  start(): void {
    if (!this.config.enabled) {
      logger.info("Catalog ingestor sync disabled", {
        clientId: this.config.clientId,
      });
      return;
    }

    if (this.providers.length === 0) {
      logger.warn("Catalog ingestor has no providers configured", {
        clientId: this.config.clientId,
      });
      return;
    }

    if (this.config.runOnStart) {
      void this.runOnce();
    }

    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.config.syncIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async runOnce(): Promise<void> {
    if (this.running) {
      logger.warn("Catalog sync skipped because previous cycle is still running", {
        clientId: this.config.clientId,
      });
      return;
    }

    this.running = true;
    let collected = 0;
    let published = 0;
    let failed = 0;

    logger.info("Catalog sync cycle started", {
      clientId: this.config.clientId,
      providers: this.providers.map((provider) => provider.name),
      batchSize: this.config.batchSize,
    });

    try {
      for (const provider of this.providers) {
        const drafts = await provider.collect({
          batchSize: this.config.batchSize,
          userAgent: this.config.userAgent,
          customSourceFile: this.config.customSourceFile,
          customUrl: this.config.customUrl,
          browserHeadless: this.config.browserHeadless,
          browserTimeoutMs: this.config.browserTimeoutMs,
          browserWaitUntil: this.config.browserWaitUntil,
          browserTextMaxChars: this.config.browserTextMaxChars,
          browserLinksMaxCount: this.config.browserLinksMaxCount,
        });
        const limitedDrafts = drafts.slice(0, this.config.batchSize);
        collected += limitedDrafts.length;

        logger.info("Catalog provider collected drafts", {
          provider: provider.name,
          drafts: limitedDrafts.length,
          implementation: limitedDrafts.length === 0 ? "stub" : "active",
        });

        for (const draft of limitedDrafts) {
          try {
            const item = await this.publisher.publish(draft);
            published += 1;
            logger.info("Catalog garment item published", {
              provider: item.provider,
              cacheKey: item.cacheKey,
              storageId: item.object.storageId,
              key: item.object.key,
            });
          } catch (error) {
            failed += 1;
            logger.warn("Catalog garment item publish failed", {
              provider: provider.name,
              externalId: draft.externalId,
              productUrl: draft.productUrl,
              error,
            });
          }
        }
      }
    } finally {
      this.running = false;
      logger.info("Catalog sync cycle finished", {
        clientId: this.config.clientId,
        collected,
        published,
        failed,
      });
    }
  }
}
