import type {
  JobResultUpdateRequest,
  TelegramJobCallbackRequest,
  WorkerJobRequest,
} from "../../shared/contracts/index.js";
import { postJson } from "../../shared/http.js";
import { createLogger } from "../../shared/logger.js";
import type { CoordinatorClient } from "../api/coordinatorClient.js";
import type { WorkerConfig } from "../config/index.js";
import { runSelectedTryOnModel } from "../models/index.js";
import { runIdealOutfitJob } from "./idealOutfit.js";
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
    logger.info("Model execution started", {
      jobId: job.jobId,
      provider,
      task,
    });
    const result = task === "ideal-outfit"
      ? await runIdealOutfitJob({
          job,
          config,
          coordinator,
          signal,
        })
      : await runSelectedTryOnModel({
          job,
          config,
          coordinator,
          signal,
        });
    logger.info("Model execution finished", {
      jobId: job.jobId,
      provider,
      messageLength: result.message.length,
      files: result.files?.length ?? 0,
    });
    let deliveryError: unknown;

    if (job.callbackUrl) {
      const callback: TelegramJobCallbackRequest = {
        jobId: job.jobId,
        client: job.client,
        result,
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
          result,
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
          result,
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
    const update: JobResultUpdateRequest = {
      jobId: job.jobId,
      status: wasCancelled ? "cancelled" : "failed",
      error: {
        code: wasCancelled
          ? "worker_job_cancelled"
          : modelError?.code ?? "worker_processing_failed",
        message: error instanceof Error ? error.message : "Worker processing failed",
        retryable: wasCancelled ? false : modelError?.retryable ?? true,
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
      message: failureMessage(update),
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

function failureMessage(update: JobResultUpdateRequest): string {
  if (update.status === "cancelled") {
    return "Обработка запроса была отменена. Попробуйте отправить фото заново.";
  }

  if (update.error?.code === "openai_image_content_type_unsupported") {
    return "Не удалось обработать изображение: файл не распознан как фото. Отправьте четкую фотографию в формате JPG, PNG или WEBP.";
  }

  if (update.error?.code === "openai_api_429") {
    return "Сервер временно уперся в лимит OpenAI. Я повторил запрос несколько раз, но лимит не освободился. Попробуйте еще раз через минуту.";
  }

  if (update.error?.code?.startsWith("ideal_outfit")) {
    return "Не удалось собрать идеальный образ. Попробуйте отправить другое фото или проверьте, что в storage есть каталог вещей.";
  }

  return "Не удалось выполнить разбор внешности. Попробуйте отправить другое четкое фото с видимым лицом чуть позже.";
}
