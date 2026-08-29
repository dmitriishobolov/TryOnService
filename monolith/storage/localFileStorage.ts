import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import type { ImageData, ImageKind, StoredImage } from "../types.js";

export class LocalFileStorage {
  constructor(private readonly root: string) {}

  async saveImage(
    kind: ImageKind,
    image: ImageData,
    metadata: StoredImage["metadata"] = {},
  ): Promise<StoredImage> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const folder = join(this.root, kind, createdAt.slice(0, 10));
    const filename = `${id}${extensionForImage(image)}`;
    const absolutePath = join(folder, filename);

    await mkdir(folder, { recursive: true });
    await writeFile(absolutePath, image.buffer);

    return {
      id,
      kind,
      absolutePath,
      relativePath: relative(this.root, absolutePath).replace(/\\/g, "/"),
      filename,
      contentType: image.contentType,
      sizeBytes: image.buffer.length,
      createdAt,
      metadata,
    };
  }

  async readImage(stored: StoredImage): Promise<ImageData> {
    return {
      buffer: await readFile(stored.absolutePath),
      contentType: stored.contentType,
      filename: stored.filename,
    };
  }
}

function extensionForImage(image: ImageData): string {
  const fromFilename = extname(image.filename);

  if (fromFilename) {
    return fromFilename;
  }

  const mapped: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
  };

  return mapped[image.contentType.split(";")[0]?.trim().toLowerCase() ?? ""] ?? ".jpg";
}
