import type {
  JobResultUpdateRequest,
  MarketProductRef,
  TelegramJobCallbackRequest,
  WorkerJobRequest,
} from "../../shared/contracts/index.js";
import { postJson } from "../../shared/http.js";
import { createLogger } from "../../shared/logger.js";
import type { CoordinatorClient } from "../api/coordinatorClient.js";
import type { WorkerConfig } from "../config/index.js";
import { searchMarketplaceProducts } from "../market/index.js";
import {
  readCachedMarketplaceProducts,
  writeCachedMarketplaceProducts,
} from "../market/storageCache.js";
import { MarketplaceError } from "../market/utils.js";
import { runSelectedTryOnModel } from "../models/index.js";
import { TryOnModelError } from "../models/providerUtils.js";

const logger = createLogger("worker");

export async function runWorkerJob(
  job: WorkerJobRequest,
  config: WorkerConfig,
  coordinator: CoordinatorClient,
  callbackToken?: string,
  signal?: AbortSignal,
): Promise<void> {
  const provider = job.payload.model?.provider ?? "mock";
  const task = job.payload.model?.task;

  logger.info("Worker job processing started", {
    jobId: job.jobId,
    workerId: config.workerId,
    provider,
    task,
    inputFiles: job.payload.inputFiles?.length ?? 0,
    hasCallbackUrl: Boolean(job.callbackUrl),
  });
  await coordinator.reportProgress({
    jobId: job.jobId,
    status: "running",
    message: "Worker started processing",
  });
  logger.info("Worker job progress reported", {
    jobId: job.jobId,
    status: "running",
  });

  try {
    const marketProducts = await searchRequestedMarketProducts(
      job,
      config,
      coordinator,
      signal,
    );
    logger.info("Model execution started", {
      jobId: job.jobId,
      provider,
      task,
    });
    const result = await runSelectedTryOnModel({
      job,
      config,
      coordinator,
      signal,
    });
    const enrichedResult = attachMarketplaceProducts(result, marketProducts);
    logger.info("Model execution finished", {
      jobId: job.jobId,
      provider,
      messageLength: enrichedResult.message.length,
      files: enrichedResult.files?.length ?? 0,
      marketProducts: enrichedResult.marketProducts?.length ?? 0,
    });
    let deliveryError: unknown;

    if (job.callbackUrl) {
      const callback: TelegramJobCallbackRequest = {
        jobId: job.jobId,
        client: job.client,
        result: enrichedResult,
      };

      try {
        logger.info("Client callback delivery started", {
          jobId: job.jobId,
          callbackUrl: job.callbackUrl,
          chatId: job.client.chatId,
        });
        await postJson(
          job.callbackUrl,
          callback,
          callbackToken ? { "x-client-callback-token": callbackToken } : {},
          {
            retries: config.httpClientRetries,
            timeoutMs: config.httpClientTimeoutMs,
          },
        );
        logger.info("Client callback delivery succeeded", {
          jobId: job.jobId,
          chatId: job.client.chatId,
        });
      } catch (error) {
        logger.error("Client callback delivery failed", {
          jobId: job.jobId,
          callbackUrl: job.callbackUrl,
          chatId: job.client.chatId,
          error,
        });
        deliveryError = error;
      }
    } else {
      logger.warn("Worker job has no callbackUrl", {
        jobId: job.jobId,
      });
    }

    const update: JobResultUpdateRequest = deliveryError
      ? {
          jobId: job.jobId,
          status: "delivery_failed",
          result: enrichedResult,
          error: {
            code: "client_callback_failed",
            message:
              deliveryError instanceof Error
                ? deliveryError.message
                : "Client callback delivery failed",
            retryable: true,
          },
        }
      : {
          jobId: job.jobId,
          status: "succeeded",
          result: enrichedResult,
        };

    await coordinator.reportResult(update);
    logger.info("Worker job result reported", {
      jobId: job.jobId,
      status: update.status,
      deliveryFailed: Boolean(deliveryError),
    });
  } catch (error) {
    const wasCancelled =
      error instanceof Error &&
      (error.name === "AbortError" || signal?.aborted === true);
    const modelError = error instanceof TryOnModelError ? error : undefined;
    const marketplaceError =
      error instanceof MarketplaceError ? error : undefined;
    const update: JobResultUpdateRequest = {
      jobId: job.jobId,
      status: wasCancelled ? "cancelled" : "failed",
      error: {
        code:
          wasCancelled
            ? "worker_job_cancelled"
            : modelError?.code ??
              marketplaceError?.code ??
              "worker_processing_failed",
        message: error instanceof Error ? error.message : "Worker processing failed",
        retryable:
          wasCancelled
            ? false
            : modelError?.retryable ?? marketplaceError?.retryable ?? true,
      },
    };

    logger.error("Worker job processing failed", {
      jobId: job.jobId,
      provider,
      status: update.status,
      errorCode: update.error?.code,
      retryable: update.error?.retryable,
      error,
    });
    await deliverFailureCallback(job, config, callbackToken, update);
    await coordinator.reportResult(update);
    logger.info("Worker job failure reported", {
      jobId: job.jobId,
      status: update.status,
      errorCode: update.error?.code,
    });
  }
}

async function searchRequestedMarketProducts(
  job: WorkerJobRequest,
  config: WorkerConfig,
  coordinator: CoordinatorClient,
  signal?: AbortSignal,
): Promise<MarketProductRef[]> {
  const market = job.payload.market;

  if (!market) {
    return [];
  }

  try {
    logger.info("Marketplace product search requested", {
      jobId: job.jobId,
      providers: market.providers,
      query: market.query,
      limit: market.limit,
      required: market.required ?? false,
    });
    const cachedProducts = await readCachedMarketplaceProducts({
      job,
      config,
      coordinator,
    });

    if (cachedProducts) {
      logger.info("Marketplace product search served from storage cache", {
        jobId: job.jobId,
        products: cachedProducts.length,
        providers: [...new Set(cachedProducts.map((product) => product.provider))],
      });

      return cachedProducts;
    }

    const products = await searchMarketplaceProducts({
      selection: market,
      config,
      fallbackQuery: job.payload.text,
      signal,
    });

    logger.info("Marketplace product search succeeded", {
      jobId: job.jobId,
      products: products.length,
      providers: [...new Set(products.map((product) => product.provider))],
    });
    void writeCachedMarketplaceProducts({
      job,
      config,
      coordinator,
      products,
    });

    return products;
  } catch (error) {
    logger.warn("Marketplace product search failed", {
      jobId: job.jobId,
      required: market.required ?? false,
      error,
    });

    if (market.required) {
      throw error;
    }

    return [];
  }
}

function attachMarketplaceProducts(
  result: TelegramJobCallbackRequest["result"],
  products: MarketProductRef[],
): TelegramJobCallbackRequest["result"] {
  if (products.length === 0) {
    return result;
  }

  return {
    ...result,
    message: `${result.message}\n\n${formatMarketplaceProducts(products)}`,
    marketProducts: products,
  };
}

function formatMarketplaceProducts(products: MarketProductRef[]): string {
  const lines = products.map((product, index) => {
    const price = product.price ? `, ${formatPrice(product.price)}` : "";
    const productLink = product.productUrl
      ? `, [товар](${product.productUrl})`
      : "";
    const imageLink = product.imageUrl ? `, [фото](${product.imageUrl})` : "";
    const brand = product.brand ? `${product.brand}: ` : "";

    return `${index + 1}. **${marketplaceName(product.provider)}:** ${brand}${product.title}${price}${productLink}${imageLink}`;
  });

  return `**Подборка товаров**\n${lines.join("\n")}`;
}

function formatPrice(price: NonNullable<MarketProductRef["price"]>): string {
  if (!price.currency) {
    return String(price.amount);
  }

  try {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: price.currency,
      maximumFractionDigits: 2,
    }).format(price.amount);
  } catch {
    return `${price.amount} ${price.currency}`;
  }
}

function marketplaceName(provider: MarketProductRef["provider"]): string {
  if (provider === "aliexpress") {
    return "AliExpress";
  }

  if (provider === "ozon") {
    return "Ozon";
  }

  if (provider === "wildberries") {
    return "Wildberries";
  }

  if (provider === "tsum") {
    return "TSUM";
  }

  if (provider === "tsum-outlet") {
    return "TSUM Outlet";
  }

  return "O'STIN";
}

async function deliverFailureCallback(
  job: WorkerJobRequest,
  config: WorkerConfig,
  callbackToken: string | undefined,
  update: JobResultUpdateRequest,
): Promise<void> {
  if (!job.callbackUrl) {
    logger.warn("Worker failed job has no callbackUrl", {
      jobId: job.jobId,
      status: update.status,
      errorCode: update.error?.code,
    });
    return;
  }

  const callback: TelegramJobCallbackRequest = {
    jobId: job.jobId,
    client: job.client,
    result: {
      message: failureMessage(job, update),
    },
  };

  try {
    logger.info("Failure callback delivery started", {
      jobId: job.jobId,
      callbackUrl: job.callbackUrl,
      chatId: job.client.chatId,
      errorCode: update.error?.code,
    });
    await postJson(
      job.callbackUrl,
      callback,
      callbackToken ? { "x-client-callback-token": callbackToken } : {},
      {
        retries: config.httpClientRetries,
        timeoutMs: config.httpClientTimeoutMs,
      },
    );
    logger.info("Failure callback delivery succeeded", {
      jobId: job.jobId,
      chatId: job.client.chatId,
      errorCode: update.error?.code,
    });
  } catch (callbackError) {
    logger.error("Failure callback delivery failed", {
      jobId: job.jobId,
      callbackUrl: job.callbackUrl,
      chatId: job.client.chatId,
      errorCode: update.error?.code,
      error: callbackError,
    });
  }
}

function failureMessage(
  job: WorkerJobRequest,
  update: JobResultUpdateRequest,
): string {
  if (update.status === "cancelled") {
    return "Обработка запроса была отменена. Попробуйте отправить фото заново.";
  }

  if (update.error?.code === "openai_image_content_type_unsupported") {
    return "Не удалось обработать изображение: файл не распознан как фото. Отправьте четкую фотографию в формате JPG, PNG или WEBP.";
  }

  if (update.error?.code.startsWith("market_")) {
    return "Не удалось подобрать товары в маркетплейсах. Попробуйте изменить описание одежды или повторить запрос позже.";
  }

  if (update.error?.code === "openai_api_429") {
    return "Сервер временно уперся в лимит OpenAI. Я повторил запрос несколько раз, но лимит не освободился. Попробуйте еще раз через минуту.";
  }

  if (job.payload.model?.task === "wardrobe-recommendation") {
    return "Не удалось выполнить подбор образа или товаров. Попробуйте повторить запрос чуть позже.";
  }

  return "Не удалось выполнить разбор внешности. Попробуйте отправить другое четкое фото с видимым лицом чуть позже.";
}
