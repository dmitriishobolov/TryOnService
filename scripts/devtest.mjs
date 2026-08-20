import { spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devtestDir = join(rootDir, "devtest");
const appDir = join(devtestDir, "app");
const logsDir = join(devtestDir, "logs");
const runtimeDir = join(devtestDir, "runtime");
const args = new Set(process.argv.slice(2));
const buildOnly = args.has("--build-only");
const sourceEnvFileName =
  process.env.DEVTEST_ENV_FILE?.trim() || process.env.BUILD_ENV_FILE?.trim() || ".env";
const exampleEnvPath = join(rootDir, ".env.example");
const sourceEnvPath = existsSync(join(rootDir, sourceEnvFileName))
  ? join(rootDir, sourceEnvFileName)
  : exampleEnvPath;

assertInsideRoot(devtestDir);

const env = await buildDevtestEnv();
const cleanDevtest = readBoolean(env.DEVTEST_CLEAN, true);
const selectedServices = readServices(env.DEVTEST_SERVICES);

if (cleanDevtest) {
  rmSync(devtestDir, { recursive: true, force: true });
}

mkdirSync(appDir, { recursive: true });
mkdirSync(logsDir, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });

writeFileSync(join(devtestDir, ".env"), buildEnvFile(env));
writeDevtestReadme(env, selectedServices);
compileTypescript();

if (buildOnly) {
  console.log("[devtest] Build complete: devtest/app");
  console.log("[devtest] Runtime env: devtest/.env");
  process.exit(0);
}

const servicesToStart = getServicesToStart(selectedServices, env);

if (servicesToStart.length === 0) {
  throw new Error("DEVTEST_SERVICES did not select any runnable services");
}

console.log("[devtest] Starting services from devtest");
console.log(`[devtest] Logs: ${join("devtest", "logs")}`);
console.log("[devtest] Press Ctrl+C to stop all services");

const children = new Map();
let shuttingDown = false;
let exitCode = 0;

for (const service of servicesToStart) {
  startService(service, env);
}

process.once("SIGINT", () => shutdown("SIGINT", 0));
process.once("SIGTERM", () => shutdown("SIGTERM", 0));

async function buildDevtestEnv() {
  const exampleEnv = loadEnv(exampleEnvPath);
  const sourceEnv = loadEnv(sourceEnvPath);
  const merged = {
    ...exampleEnv,
    ...sourceEnv,
  };

  for (const key of Object.keys(merged)) {
    if (process.env[key] !== undefined) {
      merged[key] = process.env[key];
    }
  }

  const reservedPorts = new Set();
  const coordinatorPort = await findAvailablePort(
    readPort(merged.COORDINATOR_PORT, 3000),
    reservedPorts,
  );
  const storagePort = await findAvailablePort(
    readPort(merged.STORAGE_PORT, 4200),
    reservedPorts,
  );
  const workerPort = await findAvailablePort(
    readPort(merged.WORKER_PORT, 4001),
    reservedPorts,
  );
  const telegramPort = await findAvailablePort(
    readPort(merged.TELEGRAM_CLIENT_PORT, 4100),
    reservedPorts,
  );

  return {
    ...merged,
    BUILD_ENV_FILE: sourceEnvFileName,
    DEVTEST_ENV_FILE: sourceEnvFileName,
    DEVTEST_SERVICES:
      merged.DEVTEST_SERVICES?.trim() || "coordinator,storage,worker,telegram",
    DEVTEST_CLEAN: merged.DEVTEST_CLEAN?.trim() || "true",
    DEVTEST_REQUIRE_TELEGRAM:
      merged.DEVTEST_REQUIRE_TELEGRAM?.trim() || "false",
    COORDINATOR_PORT: String(coordinatorPort),
    COORDINATOR_PUBLIC_URL: `http://localhost:${coordinatorPort}`,
    COORDINATOR_URL: `http://localhost:${coordinatorPort}`,
    COORDINATOR_PERSISTENCE: "memory",
    REQUIRE_HTTPS_ENDPOINTS: "false",
    STORAGE_PORT: String(storagePort),
    STORAGE_PUBLIC_PROTOCOL: "http",
    STORAGE_PUBLIC_URL: "",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_ROOT: "runtime/storage/objects",
    STORAGE_METADATA_PATH: "runtime/storage/metadata.json",
    STORAGE_S3_ENDPOINT: "",
    STORAGE_S3_REGION: merged.STORAGE_S3_REGION?.trim() || "us-east-1",
    STORAGE_S3_BUCKET: "",
    STORAGE_S3_ACCESS_KEY_ID: "",
    STORAGE_S3_SECRET_ACCESS_KEY: "",
    STORAGE_S3_FORCE_PATH_STYLE:
      merged.STORAGE_S3_FORCE_PATH_STYLE?.trim() || "true",
    WORKER_PORT: String(workerPort),
    WORKER_PUBLIC_PROTOCOL: "http",
    WORKER_PUBLIC_URL: "",
    TELEGRAM_CLIENT_PORT: String(telegramPort),
    TELEGRAM_CLIENT_PUBLIC_PROTOCOL: "http",
    TELEGRAM_CLIENT_PUBLIC_URL: "",
  };
}

function compileTypescript() {
  const tscCli = join(rootDir, "node_modules", "typescript", "bin", "tsc");

  if (!existsSync(tscCli)) {
    throw new Error("TypeScript compiler was not found. Run npm install first.");
  }

  const result = spawnSync(
    process.execPath,
    [tscCli, "-p", "tsconfig.json", "--outDir", appDir],
    {
      cwd: rootDir,
      stdio: "inherit",
      env: process.env,
    },
  );

  if (result.status !== 0) {
    throw new Error(`TypeScript build failed with exit code ${result.status ?? 1}`);
  }
}

function getServicesToStart(selected, env) {
  const allServices = [
    {
      id: "coordinator",
      title: "coordinator",
      entry: "app/apps/coordinator/index.js",
    },
    {
      id: "storage",
      title: "storage",
      entry: "app/apps/storage/index.js",
    },
    {
      id: "worker",
      title: "worker",
      entry: "app/apps/worker/index.js",
    },
    {
      id: "telegram",
      title: "telegram",
      entry: "app/apps/client/telegram/index.js",
      optional: true,
      canStart: () => hasTelegramToken(env),
      skipMessage:
        "TELEGRAM_BOT_TOKEN is not configured, telegram client was skipped",
    },
  ];

  return allServices.filter((service) => {
    if (!selected.has(service.id)) {
      return false;
    }

    if (!service.canStart || service.canStart()) {
      return true;
    }

    if (service.id === "telegram" && readBoolean(env.DEVTEST_REQUIRE_TELEGRAM, false)) {
      throw new Error(
        "TELEGRAM_BOT_TOKEN is required because DEVTEST_REQUIRE_TELEGRAM=true",
      );
    }

    console.warn(`[devtest] ${service.skipMessage}`);
    return false;
  });
}

function startService(service, env) {
  const log = createWriteStream(join(logsDir, `${service.id}.log`), {
    flags: "a",
  });
  const child = spawn(process.execPath, [service.entry], {
    cwd: devtestDir,
    env: {
      ...process.env,
      ...env,
      ENV_FILE: ".env",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  children.set(service.id, { child, log });
  pipeServiceOutput(service.id, child.stdout, log, false);
  pipeServiceOutput(service.id, child.stderr, log, true);

  child.once("exit", (code, signal) => {
    log.end();
    children.delete(service.id);

    if (shuttingDown) {
      return;
    }

    exitCode = code ?? 1;
    console.error(
      `[devtest] ${service.title} exited unexpectedly with ${formatExit(
        code,
        signal,
      )}`,
    );
    shutdown(`${service.id}_exit`, exitCode || 1);
  });
}

function pipeServiceOutput(serviceId, stream, log, isError) {
  let buffered = "";

  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    log.write(chunk);
    buffered += chunk;

    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";

    for (const line of lines) {
      if (!line) {
        continue;
      }

      const target = isError ? console.error : console.log;
      target(`[${serviceId}] ${line}`);
    }
  });

  stream.on("end", () => {
    if (!buffered) {
      return;
    }

    const target = isError ? console.error : console.log;
    target(`[${serviceId}] ${buffered}`);
  });
}

function shutdown(reason, code) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  exitCode = code;
  console.log(`[devtest] Stopping services after ${reason}`);

  for (const { child } of children.values()) {
    child.kill("SIGTERM");
  }

  setTimeout(() => {
    for (const { child } of children.values()) {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }

    process.exit(exitCode);
  }, 5_000).unref();
}

function writeDevtestReadme(env, selectedServices) {
  const services = [...selectedServices].join(", ");

  writeFileSync(
    join(devtestDir, "README.md"),
    `# TryOnService devtest runtime

This folder is generated by \`npm run devtest\` or \`npm run build:devtest\`.

It is intentionally ignored by git. Runtime files, logs and local storage objects
must stay here instead of source folders or \`dist\`.

## Services

Selected services: \`${services}\`

- coordinator: ${env.COORDINATOR_URL}
- storage preferred port: ${env.STORAGE_PORT}
- worker preferred port: ${env.WORKER_PORT}
- telegram preferred callback port: ${env.TELEGRAM_CLIENT_PORT}

## Files

- \`app/\` - compiled JavaScript
- \`.env\` - generated runtime env
- \`runtime/storage/objects/\` - local object storage data
- \`logs/\` - service logs
`,
  );
}

function buildEnvFile(env) {
  const keys = [
    "BUILD_ENV_FILE",
    "DEVTEST_ENV_FILE",
    "DEVTEST_SERVICES",
    "DEVTEST_CLEAN",
    "DEVTEST_REQUIRE_TELEGRAM",
    "COORDINATOR_URL",
    "COORDINATOR_PORT",
    "COORDINATOR_PUBLIC_URL",
    "REQUIRE_HTTPS_ENDPOINTS",
    "COORDINATOR_PERSISTENCE",
    "POSTGRES_URL",
    "POSTGRES_SSL",
    "POSTGRES_MAX_CONNECTIONS",
    "ADMIN_API_KEY",
    "WORKER_REGISTRATION_KEY",
    "WORKER_REGISTRATION_MAX_INVALID_ATTEMPTS",
    "STORAGE_REGISTRATION_KEY",
    "STORAGE_REGISTRATION_MAX_INVALID_ATTEMPTS",
    "CLIENT_REGISTRATION_KEY",
    "CLIENT_REGISTRATION_MAX_INVALID_ATTEMPTS",
    "WORKER_SERVICE_KEY",
    "STORAGE_SERVICE_KEY",
    "WORKER_DISPATCH_SIGNING_KEY",
    "WORKER_DISPATCH_SIGNING_KEY_VERSION",
    "CLIENT_CALLBACK_SIGNING_KEY",
    "CLIENT_CALLBACK_SIGNING_KEY_VERSION",
    "STORAGE_ACCESS_SIGNING_KEY",
    "STORAGE_ACCESS_SIGNING_KEY_VERSION",
    "WORKER_HEARTBEAT_INTERVAL_MS",
    "WORKER_HEARTBEAT_TIMEOUT_MS",
    "CLIENT_HEARTBEAT_INTERVAL_MS",
    "CLIENT_HEARTBEAT_TIMEOUT_MS",
    "STORAGE_HEARTBEAT_INTERVAL_MS",
    "STORAGE_HEARTBEAT_TIMEOUT_MS",
    "SCHEDULER_INTERVAL_MS",
    "WORKER_DISPATCH_TOKEN_TTL_MS",
    "CLIENT_CALLBACK_TOKEN_TTL_MS",
    "STORAGE_ACCESS_TOKEN_TTL_MS",
    "JOB_ASSIGNMENT_TIMEOUT_MS",
    "API_RATE_LIMIT_WINDOW_MS",
    "API_RATE_LIMIT_MAX_REQUESTS",
    "HTTP_CLIENT_TIMEOUT_MS",
    "HTTP_CLIENT_RETRIES",
    "MAX_JSON_BODY_BYTES",
    "STORAGE_PORT",
    "STORAGE_ID",
    "STORAGE_PUBLIC_PROTOCOL",
    "STORAGE_PUBLIC_URL",
    "STORAGE_DRIVER",
    "STORAGE_LOCAL_ROOT",
    "STORAGE_METADATA_PATH",
    "STORAGE_S3_ENDPOINT",
    "STORAGE_S3_REGION",
    "STORAGE_S3_BUCKET",
    "STORAGE_S3_ACCESS_KEY_ID",
    "STORAGE_S3_SECRET_ACCESS_KEY",
    "STORAGE_S3_FORCE_PATH_STYLE",
    "STORAGE_CAPACITY_BYTES",
    "STORAGE_MAX_OBJECT_BYTES",
    "WORKER_PORT",
    "WORKER_ID",
    "WORKER_PUBLIC_PROTOCOL",
    "WORKER_PUBLIC_URL",
    "WORKER_CAPACITY",
    "WORKER_CAPABILITIES",
    "TRYON_PERSON_IMAGE_INDEX",
    "TRYON_GARMENT_IMAGE_INDEX",
    "TRYON_MODEL_POLL_INTERVAL_MS",
    "TRYON_MODEL_MAX_POLL_ATTEMPTS",
    "TRYON_MODEL_HTTP_TIMEOUT_MS",
    "MOCK_PROCESSING_DELAY_MS",
    "PRUNA_API_KEY",
    "PRUNA_API_BASE_URL",
    "PRUNA_MODEL",
    "PRUNA_PREDICTION_PATH_TEMPLATE",
    "PRUNA_OUTPUT_FORMAT",
    "PRUNA_OUTPUT_QUALITY",
    "PRUNA_PRESERVE_INPUT_SIZE",
    "PRUNA_PROMPT",
    "PRUNA_SEED",
    "PRUNA_TURBO",
    "PIXELCUT_API_KEY",
    "PIXELCUT_API_BASE_URL",
    "PIXELCUT_JOB_STATUS_PATH_TEMPLATE",
    "PIXELCUT_GARMENT_MODE",
    "PIXELCUT_PREPROCESS_GARMENT",
    "PIXELCUT_REMOVE_BACKGROUND",
    "TRYONCLOUD_API_KEY",
    "TRYONCLOUD_API_BASE_URL",
    "TRYONCLOUD_MODE",
    "GENLOOK_API_KEY",
    "GENLOOK_API_BASE_URL",
    "GENLOOK_API_KEY_HEADER",
    "GENLOOK_API_KEY_PREFIX",
    "GENLOOK_UPLOAD_MODE",
    "GENLOOK_UPLOAD_PATH",
    "GENLOOK_TRYON_PATH",
    "GENLOOK_GENERATION_PATH_TEMPLATE",
    "WEARFITS_API_KEY",
    "WEARFITS_API_BASE_URL",
    "WEARFITS_IMAGE_INPUT_MODE",
    "WEARFITS_PRODUCT_CATEGORY",
    "WEARFITS_QUALITY",
    "WEARFITS_PRESERVE_BACKGROUND",
    "OPENAI_API_KEY",
    "OPENAI_API_BASE_URL",
    "OPENAI_MODEL",
    "OPENAI_IMAGE_DETAIL",
    "OPENAI_TEXT_VERBOSITY",
    "OPENAI_REASONING_EFFORT",
    "OPENAI_REASONING_MODE",
    "OPENAI_MAX_OUTPUT_TOKENS",
    "OPENAI_STORE_RESPONSE",
    "OPENAI_ORGANIZATION",
    "OPENAI_PROJECT",
    "OPENAI_SYSTEM_PROMPT",
    "OPENAI_WARDROBE_PROMPT",
    "TELEGRAM_CLIENT_ID",
    "TELEGRAM_CLIENT_PORT",
    "TELEGRAM_CLIENT_PUBLIC_PROTOCOL",
    "TELEGRAM_CLIENT_PUBLIC_URL",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_POLLING_TIMEOUT_SECONDS",
  ];

  return `${keys.map((key) => `${key}=${env[key] ?? ""}`).join("\n")}\n`;
}

function loadEnv(filePath) {
  const result = {};

  if (!existsSync(filePath)) {
    return result;
  }

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const parsed = parseEnvLine(line);

    if (parsed) {
      result[parsed.key] = parsed.value;
    }
  }

  return result;
}

function parseEnvLine(line) {
  const trimmed = line.trim();

  if (!trimmed || trimmed.startsWith("#")) {
    return undefined;
  }

  const separatorIndex = trimmed.indexOf("=");

  if (separatorIndex <= 0) {
    return undefined;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  const value = unquote(trimmed.slice(separatorIndex + 1).trim());

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return undefined;
  }

  return { key, value };
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function readServices(rawValue) {
  const raw = rawValue?.trim() || "coordinator,storage,worker,telegram";
  const aliases = new Map([
    ["client", "telegram"],
    ["telegram-client", "telegram"],
  ]);
  const allowed = new Set(["coordinator", "storage", "worker", "telegram"]);
  const services = new Set();

  for (const item of raw.split(",")) {
    const normalized = item.trim().toLowerCase();

    if (!normalized) {
      continue;
    }

    const service = aliases.get(normalized) ?? normalized;

    if (!allowed.has(service)) {
      throw new Error(`Unknown service in DEVTEST_SERVICES: ${item}`);
    }

    services.add(service);
  }

  return services;
}

function readBoolean(rawValue, fallback) {
  const value = rawValue?.trim().toLowerCase();

  if (!value) {
    return fallback;
  }

  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }

  if (value === "false" || value === "0" || value === "no") {
    return false;
  }

  throw new Error(`Expected boolean value, got: ${rawValue}`);
}

function readPort(rawValue, fallback) {
  const value = Number(rawValue || fallback);

  if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`Invalid port value: ${rawValue}`);
  }

  return value;
}

function hasTelegramToken(env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();

  return Boolean(token && token !== "replace-with-your-telegram-bot-token");
}

async function findAvailablePort(startPort, reservedPorts) {
  for (let port = startPort; port < startPort + 100 && port <= 65_535; port += 1) {
    if (reservedPorts.has(port)) {
      continue;
    }

    if (await canListen(port)) {
      reservedPorts.add(port);
      return port;
    }
  }

  throw new Error(`No free port found near ${startPort}`);
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = createServer();

    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

function formatExit(code, signal) {
  if (signal) {
    return `signal ${signal}`;
  }

  return `exit code ${code ?? 0}`;
}

function assertInsideRoot(targetPath) {
  const relativePath = relative(rootDir, resolve(targetPath));

  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Refusing to use unsafe devtest path: ${targetPath}`);
  }
}
