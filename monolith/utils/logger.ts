export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export type LogContext = Record<string, unknown>;

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const redactedKeyPattern = /authorization|api[_-]?key|secret|password/i;

export function createLogger(service: string): Logger {
  return {
    debug: (message, context) => writeLog(service, "debug", message, context),
    info: (message, context) => writeLog(service, "info", message, context),
    warn: (message, context) => writeLog(service, "warn", message, context),
    error: (message, context) => writeLog(service, "error", message, context),
  };
}

function writeLog(
  service: string,
  level: LogLevel,
  message: string,
  context?: LogContext,
): void {
  if (!shouldLog(level)) {
    return;
  }

  const line = formatLogLine(service, level, message, context);

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

function shouldLog(level: LogLevel): boolean {
  return levelPriority[level] >= levelPriority[readLogLevel()];
}

function readLogLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();

  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }

  return "info";
}

function formatLogLine(
  service: string,
  level: LogLevel,
  message: string,
  context?: LogContext,
): string {
  const base = `${new Date().toISOString()} level=${level} service=${service} msg=${quoteValue(message)}`;
  const formattedContext = context ? formatContext(context) : "";

  return formattedContext ? `${base} ${formattedContext}` : base;
}

function formatContext(context: LogContext): string {
  return Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${sanitizeKey(key)}=${quoteValue(safeValue(key, value))}`)
    .join(" ");
}

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function safeValue(key: string, value: unknown): unknown {
  if (isSensitiveKey(key)) {
    return "[redacted]";
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => safeValue(key, item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        safeValue(entryKey, entryValue),
      ]),
    );
  }

  return value;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();

  return (
    redactedKeyPattern.test(normalized) ||
    normalized.endsWith("token") ||
    normalized.includes("_token") ||
    normalized.includes("-token")
  );
}

function quoteValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value === null) {
    return "null";
  }

  return JSON.stringify(value);
}