import type { IncomingMessage } from "node:http";

export function resolveDirectRequestAddress(request: IncomingMessage): string {
  const address = request.socket.remoteAddress;

  if (!address) {
    throw new Error("Cannot resolve direct request source address");
  }

  return normalizeRemoteAddress(address);
}

export function resolveRequesterHost(request: IncomingMessage): string {
  const forwardedFor = firstHeaderValue(request.headers["x-forwarded-for"]);
  const realIp = firstHeaderValue(request.headers["x-real-ip"]);
  const rawHost =
    forwardedFor?.split(",")[0]?.trim() ||
    realIp ||
    request.socket.remoteAddress;

  if (!rawHost) {
    throw new Error("Cannot resolve request source address");
  }

  return normalizeRemoteAddress(rawHost);
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeRemoteAddress(address: string): string {
  const trimmed = address.trim();

  if (trimmed.startsWith("[") && trimmed.includes("]")) {
    return trimmed.slice(1, trimmed.indexOf("]"));
  }

  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice("::ffff:".length);
  }

  if (trimmed === "::1") {
    return "localhost";
  }

  const ipv4WithOptionalPort = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(
    trimmed,
  );

  if (ipv4WithOptionalPort) {
    return ipv4WithOptionalPort[1];
  }

  const hostWithPort = /^([^:]+):\d+$/.exec(trimmed);

  if (hostWithPort) {
    return hostWithPort[1];
  }

  return trimmed;
}
