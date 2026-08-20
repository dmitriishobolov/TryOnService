import { createServer } from "node:net";

export async function findAvailablePort(
  preferredPort: number,
  options: {
    host?: string;
    maxAttempts?: number;
  } = {},
): Promise<number> {
  const host = options.host ?? "0.0.0.0";
  const maxAttempts = options.maxAttempts ?? 50;

  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = preferredPort + offset;

    if (await isPortAvailable(port, host)) {
      return port;
    }
  }

  throw new Error(
    `No available port found from ${preferredPort} after ${maxAttempts} attempts`,
  );
}

function isPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(false);
        return;
      }

      reject(error);
    });

    server.once("listening", () => {
      server.close(() => {
        resolve(true);
      });
    });

    server.listen(port, host);
  });
}
