import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, posix, resolve, sep } from "node:path";

import type { StorageObjectRef } from "../contracts/index.js";

export interface PutStorageObjectRequest {
  key?: string;
  data: Buffer | Uint8Array;
  contentType?: string;
}

export interface GetStorageObjectResponse {
  ref: StorageObjectRef;
  data: Buffer;
}

export interface ObjectStorage {
  putObject(request: PutStorageObjectRequest): Promise<StorageObjectRef>;
  getObject(key: string): Promise<GetStorageObjectResponse>;
  createReadStream(key: string): Promise<{ ref: StorageObjectRef; stream: ReadStream }>;
  deleteObject(key: string): Promise<void>;
  createKey(prefix: string, filename?: string): string;
}

export interface LocalObjectStorageOptions {
  rootDir: string;
  publicBaseUrl?: string;
}

export class LocalObjectStorage implements ObjectStorage {
  private readonly rootDir: string;

  constructor(private readonly options: LocalObjectStorageOptions) {
    this.rootDir = resolve(options.rootDir);
  }

  async putObject(request: PutStorageObjectRequest): Promise<StorageObjectRef> {
    const key = request.key ?? this.createKey("objects");
    const path = this.resolveObjectPath(key);
    const data = Buffer.from(request.data);

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);

    return this.createRef(key, data.length, request.contentType, data);
  }

  async getObject(key: string): Promise<GetStorageObjectResponse> {
    const path = this.resolveObjectPath(key);
    const data = await readFile(path);
    const info = await stat(path);

    return {
      ref: this.createRef(key, info.size, undefined, data),
      data,
    };
  }

  async createReadStream(
    key: string,
  ): Promise<{ ref: StorageObjectRef; stream: ReadStream }> {
    const path = this.resolveObjectPath(key);
    const data = await readFile(path);

    return {
      ref: this.createRef(key, data.length, undefined, data),
      stream: createReadStream(path),
    };
  }

  async deleteObject(key: string): Promise<void> {
    await rm(this.resolveObjectPath(key), { force: true });
  }

  createKey(prefix: string, filename = "file"): string {
    const safePrefix = sanitizePathPart(prefix);
    const safeFilename = sanitizePathPart(filename);

    return `${safePrefix}/${randomUUID()}-${safeFilename}`;
  }

  private createRef(
    key: string,
    sizeBytes: number,
    contentType: string | undefined,
    data: Buffer,
  ): StorageObjectRef {
    return {
      driver: "local",
      key,
      contentType,
      sizeBytes,
      checksumSha256: createHash("sha256").update(data).digest("hex"),
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
