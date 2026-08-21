import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compiledAppsDir = join(rootDir, "dist", "apps");
const packagesDir = join(rootDir, "dist", "packages");
const envFileName = process.env.BUILD_ENV_FILE ?? ".env";
const envFilePath = existsSync(join(rootDir, envFileName))
  ? join(rootDir, envFileName)
  : join(rootDir, ".env.example");
const exampleEnvFilePath = join(rootDir, ".env.example");
const env = {
  ...loadEnv(exampleEnvFilePath),
  ...loadEnv(envFilePath),
};
const rootPackage = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const commit = readGitValue(["rev-parse", "--short", "HEAD"]) ?? "unknown";
const builtAt = new Date().toISOString();

const services = [
  {
    name: "coordinator",
    title: "TryOnService Coordinator",
    entry: "app/apps/coordinator/index.js",
    directories: ["coordinator", "shared"],
    includeNodeModules: true,
    dependencies: rootPackage.dependencies ?? {},
    envKeys: [
      "LOG_LEVEL",
      "COORDINATOR_PORT",
      "COORDINATOR_PUBLIC_URL",
      "WORKER_REGISTRATION_KEY",
      "WORKER_SERVICE_KEY",
      "WORKER_DISPATCH_SIGNING_KEY",
      "WORKER_DISPATCH_SIGNING_KEY_VERSION",
      "CLIENT_CALLBACK_SIGNING_KEY",
      "CLIENT_CALLBACK_SIGNING_KEY_VERSION",
      "ADMIN_API_KEY",
      "WORKER_REGISTRATION_MAX_INVALID_ATTEMPTS",
      "STORAGE_REGISTRATION_KEY",
      "STORAGE_SERVICE_KEY",
      "STORAGE_ACCESS_SIGNING_KEY",
      "STORAGE_ACCESS_SIGNING_KEY_VERSION",
      "STORAGE_REGISTRATION_MAX_INVALID_ATTEMPTS",
      "CLIENT_REGISTRATION_KEY",
      "CLIENT_REGISTRATION_MAX_INVALID_ATTEMPTS",
      "REQUIRE_HTTPS_ENDPOINTS",
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
      "COORDINATOR_PERSISTENCE",
      "POSTGRES_URL",
      "POSTGRES_SSL",
      "POSTGRES_MAX_CONNECTIONS",
    ],
  },
  {
    name: "storage",
    title: "TryOnService Object Storage Node",
    entry: "app/apps/storage/index.js",
    directories: ["storage", "shared"],
    envKeys: [
      "LOG_LEVEL",
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
      "STORAGE_HEARTBEAT_INTERVAL_MS",
      "COORDINATOR_URL",
      "STORAGE_REGISTRATION_KEY",
      "STORAGE_SERVICE_KEY",
      "STORAGE_ACCESS_SIGNING_KEY",
      "STORAGE_ACCESS_SIGNING_KEY_VERSION",
      "API_RATE_LIMIT_WINDOW_MS",
      "API_RATE_LIMIT_MAX_REQUESTS",
      "HTTP_CLIENT_TIMEOUT_MS",
      "HTTP_CLIENT_RETRIES",
      "MAX_JSON_BODY_BYTES",
    ],
  },
  {
    name: "worker",
    title: "TryOnService Worker",
    entry: "app/apps/worker/index.js",
    directories: ["worker", "shared"],
    envKeys: [
      "LOG_LEVEL",
      "WORKER_PORT",
      "WORKER_ID",
      "WORKER_PUBLIC_PROTOCOL",
      "WORKER_PUBLIC_URL",
      "WORKER_CAPACITY",
      "WORKER_CAPABILITIES",
      "WORKER_HEARTBEAT_INTERVAL_MS",
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
      "MARKET_ENABLED",
      "MARKET_PROVIDERS",
      "MARKET_SEARCH_LIMIT",
      "ALIEXPRESS_APP_KEY",
      "ALIEXPRESS_APP_SECRET",
      "ALIEXPRESS_APP_SIGNATURE",
      "ALIEXPRESS_TRACKING_ID",
      "ALIEXPRESS_API_BASE_URL",
      "ALIEXPRESS_SIGN_METHOD",
      "ALIEXPRESS_TARGET_LANGUAGE",
      "ALIEXPRESS_TARGET_CURRENCY",
      "ALIEXPRESS_SHIP_TO_COUNTRY",
      "ALIEXPRESS_FIELDS",
      "ALIEXPRESS_SORT",
      "ALIEXPRESS_DELIVERY_DAYS",
      "ALIEXPRESS_PLATFORM_PRODUCT_TYPE",
      "OZON_CLIENT_ID",
      "OZON_API_KEY",
      "OZON_API_BASE_URL",
      "OZON_PRODUCT_LIST_PATH",
      "OZON_PRODUCT_INFO_LIST_PATH",
      "OZON_VISIBILITY",
      "OZON_MAX_SCAN_PRODUCTS",
      "OZON_PRODUCT_URL_TEMPLATE",
      "WILDBERRIES_API_KEY",
      "WILDBERRIES_API_BASE_URL",
      "WILDBERRIES_CARDS_LIST_PATH",
      "WILDBERRIES_MAX_SCAN_CARDS",
      "WILDBERRIES_LOCALE",
      "WILDBERRIES_WITH_PHOTO",
      "WILDBERRIES_PRODUCT_URL_TEMPLATE",
      "COORDINATOR_URL",
      "WORKER_REGISTRATION_KEY",
      "WORKER_SERVICE_KEY",
      "WORKER_DISPATCH_SIGNING_KEY",
      "WORKER_DISPATCH_SIGNING_KEY_VERSION",
      "API_RATE_LIMIT_WINDOW_MS",
      "API_RATE_LIMIT_MAX_REQUESTS",
      "HTTP_CLIENT_TIMEOUT_MS",
      "HTTP_CLIENT_RETRIES",
      "MAX_JSON_BODY_BYTES",
    ],
  },
  {
    name: "telegram-client",
    title: "TryOnService Telegram Client",
    entry: "app/apps/client/telegram/index.js",
    directories: ["client", "shared"],
    envKeys: [
      "LOG_LEVEL",
      "TELEGRAM_CLIENT_ID",
      "TELEGRAM_CLIENT_PORT",
      "TELEGRAM_CLIENT_PUBLIC_PROTOCOL",
      "TELEGRAM_CLIENT_PUBLIC_URL",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_POLLING_TIMEOUT_SECONDS",
      "COORDINATOR_URL",
      "CLIENT_REGISTRATION_KEY",
      "CLIENT_CALLBACK_SIGNING_KEY",
      "CLIENT_CALLBACK_SIGNING_KEY_VERSION",
      "CLIENT_HEARTBEAT_INTERVAL_MS",
      "API_RATE_LIMIT_WINDOW_MS",
      "API_RATE_LIMIT_MAX_REQUESTS",
      "HTTP_CLIENT_TIMEOUT_MS",
      "HTTP_CLIENT_RETRIES",
      "MAX_JSON_BODY_BYTES",
    ],
  },
];

if (!existsSync(compiledAppsDir)) {
  throw new Error("Compiled apps were not found. Run npm run build before packaging.");
}

rmSync(packagesDir, { recursive: true, force: true });
mkdirSync(packagesDir, { recursive: true });

for (const service of services) {
  writeServicePackage(service);
}

console.log(`[build-dist] Built deploy packages from ${envFileName}:`);

for (const service of services) {
  console.log(`- dist/packages/${service.name}`);
}

function writeServicePackage(service) {
  const packageDir = join(packagesDir, service.name);
  const appDir = join(packageDir, "app", "apps");

  mkdirSync(appDir, { recursive: true });

  for (const directory of service.directories) {
    cpSync(join(compiledAppsDir, directory), join(appDir, directory), {
      recursive: true,
    });
  }

  if (service.includeNodeModules) {
    cpSync(join(rootDir, "node_modules"), join(packageDir, "node_modules"), {
      recursive: true,
    });
  }

  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify(
      {
        name: `try-on-service-${service.name}`,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          start: `node ${service.entry}`,
        },
        dependencies: service.dependencies,
        engines: {
          node: ">=18",
        },
      },
      null,
      2,
    )}\n`,
  );

  writeFileSync(join(packageDir, ".env"), buildEnvFile(service.envKeys));
  writeFileSync(join(packageDir, "start.cmd"), buildWindowsStart(service.entry));
  writeFileSync(join(packageDir, "start.sh"), buildUnixStart(service.entry));
  writeFileSync(join(packageDir, "README.md"), buildPackageReadme(service));
  writeFileSync(
    join(packageDir, "BUILD_INFO.txt"),
    `service=${service.name}\ncommit=${commit}\nbuiltAt=${builtAt}\nsourceEnv=${envFileName}\n`,
  );
}

function buildEnvFile(keys) {
  return `${keys
    .map((key) => `${key}=${env[key] ?? ""}`)
    .join("\n")}\n`;
}

function buildWindowsStart(entry) {
  return `@echo off\r\ncd /d "%~dp0"\r\nnode ${entry}\r\n`;
}

function buildUnixStart(entry) {
  return `#!/usr/bin/env sh\ncd "$(dirname "$0")"\nnode ${entry}\n`;
}

function buildPackageReadme(service) {
  return `# ${service.title}

This folder is a ready-to-run deploy package generated by \`npm run build:dist\`.

## Run

Windows:

\`\`\`cmd
start.cmd
\`\`\`

Linux/macOS:

\`\`\`bash
sh start.sh
\`\`\`

Or with npm:

\`\`\`bash
npm start
\`\`\`

## Configuration

Runtime settings are stored in \`.env\` in this package. The file was generated from \`${envFileName}\` during build.

Entry point: \`${service.entry}\`
`;
}

function loadEnv(filePath) {
  const result = {};

  if (!existsSync(filePath)) {
    return result;
  }

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const parsed = parseEnvLine(line);

    if (!parsed) {
      continue;
    }

    result[parsed.key] = process.env[parsed.key] ?? parsed.value;
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

function readGitValue(args) {
  try {
    return execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}
