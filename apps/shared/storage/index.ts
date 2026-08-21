import {
  createHash,
  createHmac,
  randomUUID,
  type BinaryLike,
} from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  type ReadStream,
} from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { StorageObjectRef } from "../contracts/index.js";

export class StorageObjectTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Storage object exceeds ${maxBytes} bytes`);
  }
}

export class StorageObjectNotFoundError extends Error {
  constructor(public readonly key: string) {
    super(`Storage object not found: ${key}`);
  }
}

export interface PutStorageObjectRequest {
  key?: string;
  body: NodeJS.ReadableStream;
  contentType?: string;
  maxBytes?: number;
}

export interface GetStorageObjectResponse {
  ref: StorageObjectRef;
  stream: ReadStream | Readable;
  sizeBytes?: number;
  contentType?: string;
}

export interface ObjectStorage {
  putObject(request: PutStorageObjectRequest): Promise<StorageObjectRef>;
  getObject(key: string): Promise<GetStorageObjectResponse>;
  deleteObject(key: string): Promise<void>;
  createKey(prefix: string, filename?: string): string;
  getUsedBytes(): number | undefined;
}

export interface LocalObjectStorageOptions {
  rootDir: string;
  metadataPath?: string;
  publicBaseUrl?: string;
}

export interface S3CompatibleObjectStorageOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  metadataPath: string;
  publicBaseUrl?: string;
}

export class LocalObjectStorage implements ObjectStorage {
  private readonly rootDir: string;
  private readonly metadata: StorageMetadataIndex;

  constructor(private readonly options: LocalObjectStorageOptions) {
    this.rootDir = resolve(options.rootDir);
    this.metadata = new StorageMetadataIndex(
      resolve(options.metadataPath ?? join(this.rootDir, ".tryon-storage-metadata.json")),
    );
  }

  async putObject(request: PutStorageObjectRequest): Promise<StorageObjectRef> {
    const key = normalizeStorageKey(request.key ?? this.createKey("objects"));
    const path = this.resolveObjectPath(key);
    const tempPath = `${path}.${randomUUID()}.tmp`;
    const meter = new HashingByteLimitTransform(request.maxBytes);

    try {
      await mkdir(dirname(path), { recursive: true });
      await pipeline(
        toReadable(request.body),
        meter,
        createWriteStream(tempPath, { flags: "wx" }),
      );
      await rename(tempPath, path);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }

    const ref = this.createRef(
      key,
      meter.sizeBytes,
      request.contentType,
      meter.digestSha256(),
    );
    await this.metadata.set(ref);

    return ref;
  }

  async getObject(key: string): Promise<GetStorageObjectResponse> {
    const normalizedKey = normalizeStorageKey(key);
    const path = this.resolveObjectPath(normalizedKey);
    let info: Awaited<ReturnType<typeof stat>>;

    try {
      info = await stat(path);
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new StorageObjectNotFoundError(normalizedKey);
      }

      throw error;
    }

    const ref =
      this.metadata.get(normalizedKey) ??
      this.createRef(normalizedKey, info.size, undefined, undefined);

    return {
      ref,
      stream: createReadStream(path),
      sizeBytes: info.size,
      contentType: ref.contentType,
    };
  }

  async deleteObject(key: string): Promise<void> {
    const normalizedKey = normalizeStorageKey(key);

    await rm(this.resolveObjectPath(normalizedKey), { force: true });
    await this.metadata.delete(normalizedKey);
  }

  createKey(prefix: string, filename = "file"): string {
    const safePrefix = sanitizePathPart(prefix);
    const safeFilename = sanitizePathPart(filename);

    return `${safePrefix}/${randomUUID()}-${safeFilename}`;
  }

  getUsedBytes(): number {
    return this.metadata.getUsedBytes();
  }

  private createRef(
    key: string,
    sizeBytes: number,
    contentType: string | undefined,
    checksumSha256: string | undefined,
  ): StorageObjectRef {
    return {
      driver: "local",
      key,
      contentType,
      sizeBytes,
      checksumSha256,
      url: this.options.publicBaseUrl
        ? `${this.options.publicBaseUrl.replace(/\/$/, "")}/${encodeStorageKey(key)}`
        : undefined,
      createdAt: new Date().toISOString(),
    };
  }

  private resolveObjectPath(key: string): string {
    const normalizedKey = normalizeStorageKey(key);
    const path = resolve(this.rootDir, normalizedKey);

    if (path !== this.rootDir && !path.startsWith(`${this.rootDir}${sep}`)) {
      throw new Error("Storage object key resolves outside storage root");
    }

    return path;
  }
}

export class S3CompatibleObjectStorage implements ObjectStorage {
  private readonly endpoint: URL;
  private readonly metadata: StorageMetadataIndex;

  constructor(private readonly options: S3CompatibleObjectStorageOptions) {
    this.endpoint = new URL(options.endpoint);
    this.metadata = new StorageMetadataIndex(resolve(options.metadataPath));
  }

  async putObject(request: PutStorageObjectRequest): Promise<StorageObjectRef> {
    const key = normalizeStorageKey(request.key ?? this.createKey("objects"));
    const url = this.objectUrl(key);
    const meter = new HashingByteLimitTransform(request.maxBytes);
    const contentType = request.contentType ?? "application/octet-stream";
    const headers = this.signRequest("PUT", url, {
      "content-type": contentType,
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    });

    toReadable(request.body).pipe(meter);

    const response = await fetch(url, {
      method: "PUT",
      headers,
      body: meter,
      duplex: "half",
    } as unknown as RequestInit);

    if (!response.ok) {
      throw new Error(`S3 PUT failed with status ${response.status}`);
    }

    const ref = this.createRef(
      key,
      meter.sizeBytes,
      request.contentType,
      meter.digestSha256(),
    );
    await this.metadata.set(ref);

    return ref;
  }

  async getObject(key: string): Promise<GetStorageObjectResponse> {
    const normalizedKey = normalizeStorageKey(key);
    const url = this.objectUrl(normalizedKey);
    const headers = this.signRequest("GET", url, {
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    });
    const response = await fetch(url, {
      method: "GET",
      headers,
    });

    if (response.status === 404) {
      throw new StorageObjectNotFoundError(normalizedKey);
    }

    if (!response.ok || !response.body) {
      throw new Error(`S3 GET failed with status ${response.status}`);
    }

    const contentLength = readContentLength(response.headers);
    const ref =
      this.metadata.get(normalizedKey) ??
      this.createRef(
        normalizedKey,
        contentLength,
        response.headers.get("content-type") ?? undefined,
        undefined,
      );

    return {
      ref,
      stream: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      sizeBytes: contentLength ?? ref.sizeBytes,
      contentType: response.headers.get("content-type") ?? ref.contentType,
    };
  }

  async deleteObject(key: string): Promise<void> {
    const normalizedKey = normalizeStorageKey(key);
    const url = this.objectUrl(normalizedKey);
    const headers = this.signRequest("DELETE", url, {
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    });
    const response = await fetch(url, {
      method: "DELETE",
      headers,
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`S3 DELETE failed with status ${response.status}`);
    }

    await this.metadata.delete(normalizedKey);
  }

  createKey(prefix: string, filename = "file"): string {
    const safePrefix = sanitizePathPart(prefix);
    const safeFilename = sanitizePathPart(filename);

    return `${safePrefix}/${randomUUID()}-${safeFilename}`;
  }

  getUsedBytes(): number {
    return this.metadata.getUsedBytes();
  }

  private createRef(
    key: string,
    sizeBytes: number | undefined,
    contentType: string | undefined,
    checksumSha256: string | undefined,
  ): StorageObjectRef {
    return {
      driver: "s3",
      key,
      bucket: this.options.bucket,
      contentType,
      sizeBytes,
      checksumSha256,
      url: this.options.publicBaseUrl
        ? `${this.options.publicBaseUrl.replace(/\/$/, "")}/${encodeStorageKey(key)}`
        : undefined,
      createdAt: new Date().toISOString(),
    };
  }

  private objectUrl(key: string): URL {
    const encodedKey = encodeStorageKey(key);
    const base = new URL(this.endpoint);
    const basePath = base.pathname.replace(/\/$/, "");

    if (this.options.forcePathStyle ?? true) {
      base.pathname = `${basePath}/${encodeURIComponent(this.options.bucket)}/${encodedKey}`;
      return base;
    }

    base.hostname = `${this.options.bucket}.${base.hostname}`;
    base.pathname = `${basePath}/${encodedKey}`;

    return base;
  }

  private signRequest(
    method: "GET" | "PUT" | "DELETE",
    url: URL,
    headers: Record<string, string>,
  ): Record<string, string> {
    const now = new Date();
    const amzDate = toAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const signedHeadersMap = normalizeHeaders({
      ...headers,
      host: url.host,
      "x-amz-date": amzDate,
    });
    const signedHeaderNames = Object.keys(signedHeadersMap).sort();
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${signedHeadersMap[name]}\n`)
      .join("");
    const signedHeaders = signedHeaderNames.join(";");
    const payloadHash =
      signedHeadersMap["x-amz-content-sha256"] ?? hashHex("");
    const credentialScope = `${dateStamp}/${this.options.region}/s3/aws4_request`;
    const canonicalRequest = [
      method,
      url.pathname,
      canonicalQuery(url),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      hashHex(canonicalRequest),
    ].join("\n");
    const signingKey = createSigningKey(
      this.options.secretAccessKey,
      dateStamp,
      this.options.region,
    );
    const signature = createHmac("sha256", signingKey)
      .update(stringToSign)
      .digest("hex");

    return {
      ...headers,
      "X-Amz-Date": amzDate,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${this.options.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }
}

interface StorageMetadataFile {
  version: 1;
  objects: StorageObjectRef[];
}

class StorageMetadataIndex {
  private readonly objects = new Map<string, StorageObjectRef>();
  private usedBytes = 0;
  private persistQueue = Promise.resolve();

  constructor(private readonly metadataPath: string) {
    this.load();
  }

  get(key: string): StorageObjectRef | undefined {
    return this.objects.get(normalizeStorageKey(key));
  }

  getUsedBytes(): number {
    return this.usedBytes;
  }

  async set(ref: StorageObjectRef): Promise<void> {
    const normalizedKey = normalizeStorageKey(ref.key);
    const existing = this.objects.get(normalizedKey);

    this.objects.set(normalizedKey, {
      ...ref,
      key: normalizedKey,
      createdAt: existing?.createdAt ?? ref.createdAt,
    });
    this.usedBytes += (ref.sizeBytes ?? 0) - (existing?.sizeBytes ?? 0);
    await this.persist();
  }

  async delete(key: string): Promise<void> {
    const normalizedKey = normalizeStorageKey(key);
    const existing = this.objects.get(normalizedKey);

    if (!existing) {
      return;
    }

    this.objects.delete(normalizedKey);
    this.usedBytes -= existing.sizeBytes ?? 0;
    await this.persist();
  }

  private load(): void {
    if (!existsSync(this.metadataPath)) {
      return;
    }

    const raw = JSON.parse(readFileSync(this.metadataPath, "utf8")) as StorageMetadataFile;

    if (raw.version !== 1 || !Array.isArray(raw.objects)) {
      return;
    }

    for (const object of raw.objects) {
      if (typeof object.key !== "string") {
        continue;
      }

      const key = normalizeStorageKey(object.key);
      this.objects.set(key, {
        ...object,
        key,
      });
      this.usedBytes += object.sizeBytes ?? 0;
    }
  }

  private persist(): Promise<void> {
    const nextPersist = this.persistQueue.then(
      () => this.persistNow(),
      () => this.persistNow(),
    );
    this.persistQueue = nextPersist.catch(() => undefined);

    return nextPersist;
  }

  private async persistNow(): Promise<void> {
    const payload: StorageMetadataFile = {
      version: 1,
      objects: [...this.objects.values()],
    };
    const tempPath = `${this.metadataPath}.${randomUUID()}.tmp`;

    await mkdir(dirname(this.metadataPath), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
    await rename(tempPath, this.metadataPath);
  }
}

class HashingByteLimitTransform extends Transform {
  private readonly hash = createHash("sha256");
  private isDigestRead = false;
  sizeBytes = 0;

  constructor(private readonly maxBytes?: number) {
    super();
  }

  _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.sizeBytes += buffer.length;

    if (this.maxBytes !== undefined && this.sizeBytes > this.maxBytes) {
      callback(new StorageObjectTooLargeError(this.maxBytes));
      return;
    }

    this.hash.update(buffer);
    callback(null, buffer);
  }

  digestSha256(): string {
    if (this.isDigestRead) {
      throw new Error("Storage object checksum has already been read");
    }

    this.isDigestRead = true;

    return this.hash.digest("hex");
  }
}

export function normalizeStorageKey(key: string): string {
  const normalized = posix.normalize(key.replace(/\\/g, "/")).replace(/^\/+/, "");

  if (
    !normalized ||
    normalized === "." ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new Error("Invalid storage object key");
  }

  return normalized;
}

function toReadable(stream: NodeJS.ReadableStream): Readable {
  return stream instanceof Readable
    ? stream
    : Readable.from(stream as AsyncIterable<Buffer | string>);
}

function sanitizePathPart(value: string): string {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "-"))
    .filter(Boolean)
    .join("/");
}

function encodeStorageKey(key: string): string {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function readContentLength(headers: Headers): number | undefined {
  const value = Number(headers.get("content-length"));

  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      value.trim().replace(/\s+/g, " "),
    ]),
  );
}

function toAmzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "");
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .sort(([keyA, valueA], [keyB, valueB]) =>
      keyA === keyB ? valueA.localeCompare(valueB) : keyA.localeCompare(keyB),
    )
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function hashHex(value: BinaryLike): string {
  return createHash("sha256").update(value).digest("hex");
}

function createSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
): Buffer {
  const dateKey = createHmac("sha256", `AWS4${secretAccessKey}`)
    .update(dateStamp)
    .digest();
  const dateRegionKey = createHmac("sha256", dateKey).update(region).digest();
  const dateRegionServiceKey = createHmac("sha256", dateRegionKey)
    .update("s3")
    .digest();

  return createHmac("sha256", dateRegionServiceKey)
    .update("aws4_request")
    .digest();
}
