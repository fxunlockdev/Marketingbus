import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { AppError } from "../http";
import { MAX_IMAGE_BYTES } from "./images";
export type AssetStore = { put(key: string, data: Buffer, contentType?: "image/webp" | "image/png" | "video/mp4", immutable?: boolean): Promise<void>; get(key: string): Promise<Uint8Array>; remove(key: string): Promise<void> };
export function assetStore(maxBytes = MAX_IMAGE_BYTES): AssetStore {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 20 * 1024 * 1024) throw Error("Invalid private storage size bound");
  const { ASSET_S3_ENDPOINT: endpoint, ASSET_S3_BUCKET: bucket, ASSET_S3_ACCESS_KEY_ID: accessKeyId, ASSET_S3_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || new URL(endpoint).protocol !== "https:") throw new AppError(503, "Private asset storage is not configured yet.");
  const client = new S3Client({ endpoint, region: process.env.ASSET_S3_REGION || "auto", credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1, forcePathStyle: false });
  return {
    async put(key, data, contentType = "image/webp", immutable = false) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: data, ContentType: contentType, CacheControl: "private, no-store", ...(immutable ? { IfNoneMatch: "*" } : {}) }), { abortSignal: AbortSignal.timeout(30_000) });
    },
    async get(key) {
      const deadline = AbortSignal.timeout(30_000);
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: deadline });
      if (!result.Body) throw Error("Invalid stored object");
      const reader = result.Body.transformToWebStream().getReader(), chunks: Uint8Array[] = []; let length = 0;
      const abort = () => { void reader.cancel().catch(() => {}); };
      deadline.addEventListener("abort", abort, { once: true });
      try {
        if (!Number.isSafeInteger(result.ContentLength) || result.ContentLength! < 0 || result.ContentLength! > maxBytes) throw Error("Invalid stored object");
        while (true) {
          deadline.throwIfAborted();
          const chunk = await reader.read(); deadline.throwIfAborted(); if (chunk.done) break;
          length += chunk.value.length;
          if (length > maxBytes) throw Error("Stored object exceeds limit");
          chunks.push(chunk.value);
        }
        if (length !== result.ContentLength) throw Error("Stored object length mismatch");
        return Buffer.concat(chunks);
      } finally {
        deadline.removeEventListener("abort", abort);
        await reader.cancel().catch(() => {}); reader.releaseLock();
      }
    },
    async remove(key) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(30_000) }); },
  };
}
