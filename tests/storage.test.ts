import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const send = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { send = send; },
  PutObjectCommand: class { constructor(public input: unknown) {} },
  GetObjectCommand: class { constructor(public input: unknown) {} },
  DeleteObjectCommand: class { constructor(public input: unknown) {} },
}));
import { assetStore } from "../src/lib/assets/storage";
describe("bounded private object transport", () => {
  beforeEach(() => {
    vi.stubEnv("ASSET_S3_ENDPOINT", "https://storage.example.test"); vi.stubEnv("ASSET_S3_BUCKET", "test-only");
    vi.stubEnv("ASSET_S3_ACCESS_KEY_ID", "test-only"); vi.stubEnv("ASSET_S3_SECRET_ACCESS_KEY", "test-only"); send.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());
  function response(length: number | undefined, chunks: string[]) {
    return { ContentLength: length, Body: { transformToWebStream: () => new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(Buffer.from(chunk)); controller.close(); } }) } };
  }
  it("reads a bounded stream and rejects invalid transport limits", async () => {
    send.mockResolvedValue(response(4, ["ab", "cd"])); expect(await assetStore(4).get("key")).toEqual(Buffer.from("abcd"));
    expect(() => assetStore(21 * 1024 * 1024)).toThrow("size bound");
  });
  it("rejects oversized or missing declared lengths before materializing the object", async () => {
    send.mockResolvedValue(response(5, ["abcde"])); await expect(assetStore(4).get("key")).rejects.toThrow("Invalid stored");
    send.mockResolvedValue(response(undefined, ["abc"])); await expect(assetStore(4).get("key")).rejects.toThrow("Invalid stored");
  });
  it("rejects dishonest declared lengths and truncated downloads", async () => {
    send.mockResolvedValue(response(4, ["abc", "de"])); await expect(assetStore(4).get("key")).rejects.toThrow("exceeds limit");
    send.mockResolvedValue(response(4, ["ab"])); await expect(assetStore(4).get("key")).rejects.toThrow("length mismatch");
  });
  it("writes video with its media type and an immutable object precondition", async () => {
    send.mockResolvedValue({}); await assetStore().put("private.mp4", Buffer.from("fixture"), "video/mp4", true);
    expect(send.mock.calls[0][0].input).toMatchObject({ Key: "private.mp4", ContentType: "video/mp4", IfNoneMatch: "*", CacheControl: "private, no-store" });
  });
});
