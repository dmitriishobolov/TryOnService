export interface TelegramClientConfig {
  port: number;
  publicUrl: string;
  coordinatorUrl: string;
  botToken: string;
  pollingTimeoutSeconds: number;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }

  return value;
}

function readString(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function readRequiredString(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

export function loadTelegramClientConfig(): TelegramClientConfig {
  const port = readNumber("TELEGRAM_CLIENT_PORT", 4100);

  return {
    port,
    publicUrl: readString("TELEGRAM_CLIENT_PUBLIC_URL", `http://localhost:${port}`),
    coordinatorUrl: readString("COORDINATOR_URL", "http://localhost:3000"),
    botToken: readRequiredString("TELEGRAM_BOT_TOKEN"),
    pollingTimeoutSeconds: readNumber("TELEGRAM_POLLING_TIMEOUT_SECONDS", 25),
  };
}
