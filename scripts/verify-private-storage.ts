import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { get as httpsGet } from "node:https";
import { S3Client, HeadBucketCommand, HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { assetStore } from "../src/lib/assets/storage";
let phase = "fixture validation";

async function main() {
  assert.match(process.env.PRIVATE_STORAGE_FIXTURE ?? "", /^marketingbus-storage-test-[a-f0-9-]{36}$/);
  const endpoint = new URL(process.env.ASSET_S3_ENDPOINT!);
  assert.equal(endpoint.protocol, "https:"); assert.equal(endpoint.hostname, "127.0.0.1");
  const bucket = process.env.ASSET_S3_BUCKET!; assert.match(bucket, /^fixture-[a-f0-9-]{36}$/);
  const credentials = { accessKeyId: process.env.ASSET_S3_ACCESS_KEY_ID!, secretAccessKey: process.env.ASSET_S3_SECRET_ACCESS_KEY! };
  const config = { endpoint: endpoint.href, region: "us-east-1", credentials, maxAttempts: 1, forcePathStyle: false };
  const client = new S3Client(config), wrong = new S3Client({ ...config, credentials: { ...credentials, secretAccessKey: "invalid-test-secret" } });
  const store = assetStore(), keys: string[] = [];
  const status = (code: number) => (error: unknown) => !!error && typeof error === "object" && "$metadata" in error && (error.$metadata as { httpStatusCode?: number }).httpStatusCode === code;
  try {
    phase = "untrusted TLS rejection";
    await assert.rejects(new Promise<void>((resolve, reject) => {
      const request = httpsGet(endpoint, { ca: [], rejectUnauthorized: true }, response => { response.resume(); resolve(); });
      request.setTimeout(3000, () => request.destroy(Error("TLS timeout")));
      request.on("error", reject);
    }), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "DEPTH_ZERO_SELF_SIGNED_CERT");
    phase = "bucket readiness";
    for (let attempt = 0; ; attempt++) {
      try { await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(2000) }); break; }
      catch (error) { if (attempt >= 119) throw error; await delay(500); }
    }
    // Bytes here exercise real transport and metadata, not codecs or media validity.
    for (const contentType of ["image/webp", "image/png", "video/mp4", "audio/wav", "audio/mpeg"] as const) {
      const key = `transport/${randomUUID()}`, original = Buffer.from(`private-${contentType}`); keys.push(key);
      phase = `${contentType} write/read`;
      await store.put(key, original, contentType, true);
      assert.deepEqual(Buffer.from(await store.get(key)), original);
      const meta = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      assert.equal(meta.ContentType, contentType); assert.equal(meta.CacheControl, "private, no-store"); assert.equal(meta.ContentLength, original.length);
      phase = `${contentType} immutability`;
      await assert.rejects(store.put(key, Buffer.from("replacement"), contentType, true), status(412));
      assert.deepEqual(Buffer.from(await store.get(key)), original);
      await assert.rejects(assetStore(1).get(key), /Invalid stored object/);
      phase = `${contentType} private access`;
      await assert.rejects(wrong.send(new GetObjectCommand({ Bucket: bucket, Key: key })), status(403));
      const anonymous = await fetch(new URL(`/${bucket}/${key}`, endpoint), { redirect: "error", signal: AbortSignal.timeout(3000) });
      assert.equal(anonymous.status, 403); await anonymous.body?.cancel();
      phase = `${contentType} deletion`;
      await store.remove(key);
      await assert.rejects(store.get(key), status(404));
    }
    phase = "concurrent immutable writes";
    const concurrentKey = `transport/${randomUUID()}`; keys.push(concurrentKey);
    const candidates = [Buffer.from("first contender"), Buffer.from("second contender")];
    const writes = await Promise.allSettled(candidates.map(bytes => store.put(concurrentKey, bytes, "image/png", true)));
    assert.equal(writes.filter(result => result.status === "fulfilled").length, 1);
    const rejected = writes.find(result => result.status === "rejected"); assert.ok(rejected?.status === "rejected");
    assert.ok(status(412)(rejected.reason) || status(409)(rejected.reason));
    const winner = writes.findIndex(result => result.status === "fulfilled");
    assert.deepEqual(Buffer.from(await store.get(concurrentKey)), candidates[winner]);
    console.info("Real local S3 transport passed: five media types, TLS, signed/private access, no-store metadata, immutable writes, bounded reads and deletion.");
  } finally {
    for (const key of keys) await store.remove(key);
    client.destroy(); wrong.destroy();
  }
}
void main().catch(error => { console.error(JSON.stringify({ failure: "Local storage contract", phase, kind: error?.name, status: error?.$metadata?.httpStatusCode })); process.exitCode = 1; });
