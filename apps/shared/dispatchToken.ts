import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type SignedTokenPurpose =
  | "worker-dispatch"
  | "client-callback"
  | "storage-access";

export type SignedTokenStorageScope = "read" | "write" | "read-write";

export interface DispatchTokenPayload {
  purpose: SignedTokenPurpose;
  tokenId?: string;
  keyVersion?: string;
  jobId?: string;
  workerId?: string;
  clientId?: string;
  storageId?: string;
  requesterId?: string;
  scope?: SignedTokenStorageScope;
  keyPrefix?: string;
  expiresAt: string;
}

export interface DispatchTokenVerification {
  valid: boolean;
  payload?: DispatchTokenPayload;
  reason?: string;
}

export function createDispatchToken(
  payload: DispatchTokenPayload,
  secret: string,
): string {
  const encodedPayload = encodePayload({
    ...payload,
    tokenId: randomUUID(),
  });
  const signature = sign(encodedPayload, secret);

  return `${encodedPayload}.${signature}`;
}

export function verifyDispatchToken(
  token: string | undefined,
  secret: string,
): DispatchTokenVerification {
  if (!token) {
    return {
      valid: false,
      reason: "missing_token",
    };
  }

  const [encodedPayload, signature, extra] = token.split(".");

  if (!encodedPayload || !signature || extra !== undefined) {
    return {
      valid: false,
      reason: "malformed_token",
    };
  }

  if (!safeEqual(signature, sign(encodedPayload, secret))) {
    return {
      valid: false,
      reason: "invalid_signature",
    };
  }

  const payload = decodePayload(encodedPayload);

  if (!payload) {
    return {
      valid: false,
      reason: "invalid_payload",
    };
  }

  if (new Date(payload.expiresAt).getTime() <= Date.now()) {
    return {
      valid: false,
      payload,
      reason: "expired_token",
    };
  }

  return {
    valid: true,
    payload,
  };
}

function encodePayload(payload: DispatchTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(value: string): DispatchTokenPayload | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

    if (
      (parsed?.purpose !== "worker-dispatch" &&
        parsed?.purpose !== "client-callback" &&
        parsed?.purpose !== "storage-access") ||
      (parsed.tokenId !== undefined && typeof parsed.tokenId !== "string") ||
      (parsed.keyVersion !== undefined && typeof parsed.keyVersion !== "string") ||
      (parsed.jobId !== undefined && typeof parsed.jobId !== "string") ||
      (parsed.workerId !== undefined && typeof parsed.workerId !== "string") ||
      (parsed.clientId !== undefined && typeof parsed.clientId !== "string") ||
      (parsed.storageId !== undefined && typeof parsed.storageId !== "string") ||
      (parsed.requesterId !== undefined &&
        typeof parsed.requesterId !== "string") ||
      (parsed.scope !== undefined &&
        parsed.scope !== "read" &&
        parsed.scope !== "write" &&
        parsed.scope !== "read-write") ||
      (parsed.keyPrefix !== undefined && typeof parsed.keyPrefix !== "string") ||
      typeof parsed.expiresAt !== "string"
    ) {
      return undefined;
    }

    if (
      (parsed.purpose === "worker-dispatch" ||
        parsed.purpose === "client-callback") &&
      typeof parsed.jobId !== "string"
    ) {
      return undefined;
    }

    if (
      parsed.purpose === "storage-access" &&
      (typeof parsed.storageId !== "string" || typeof parsed.scope !== "string")
    ) {
      return undefined;
    }

    return parsed as DispatchTokenPayload;
  } catch {
    return undefined;
  }
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "base64url");
  const rightBuffer = Buffer.from(right, "base64url");

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
