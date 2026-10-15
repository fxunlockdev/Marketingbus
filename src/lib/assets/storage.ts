import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { AppError } from "../http";
import { MAX_IMAGE_BYTES } from "./images";
export type AssetStore = { put(key: string, data: Buffer): Promise<void>; get(key: string): Promise<Uint8Array>; remove(key: string): Promise<void> };
export function assetStore(): AssetStore {
  const { ASSET_S3_ENDPOINT: endpoint, ASSET_S3_BUCKET: bucket, ASSET_S3_ACCESS_KEY_ID: accessKeyId, ASSET_S3_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || new URL(endpoint).protocol !== "https:") throw new AppError(503, "Private asset storage is not configured yet.");
  const client = new S3Client({ endpoint, region: process.env.ASSET_S3_REGION || "auto", credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1, forcePathStyle: false });
  return {
    async put(key, data) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: data, ContentType: "image/webp", CacheControl: "private, no-store" }), { abortSignal: AbortSignal.timeout(30_000) });
    },
    async get(key) {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(30_000) });
      if (!result.Body || (result.ContentLength ?? Infinity) > MAX_IMAGE_BYTES) throw Error("Invalid stored object");
      const data = await result.Body.transformToByteArray();
      if (data.length > MAX_IMAGE_BYTES) throw Error("Stored object exceeds limit");
      return data;
    },
    async remove(key) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(30_000) }); },
  };
}
