import { afterEach, describe, expect, it, vi } from "vitest";
import { createHiggsfieldTransport, higgsfieldRequest, usdMicros, type HiggsfieldInput } from "../src/lib/providers/higgsfield";
import { configuredShotAdapters } from "../src/lib/video/generation-contracts";

function fixture() {
  const config = { keyId: "fixture-key-id", secret: "fixture-secret-never-real", verifiedUntil: new Date(Date.now() + 86400000).toISOString(), outputHosts: ["cdn.example.com"] };
  const input: HiggsfieldInput = { operationId: "local-operation-123", model: "seedance-2.5-text", durationMs: 5000, prompt: "Restrained editorial footage of architectural materials." };
  const id = "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff", statusUrl = `https://api.higgsfield.ai/requests/${id}/status`;
  const replies: (unknown | Response | Error)[] = [{ usd: "0.123456", credits: "1.500" }, { request_id: id, status: "queued", status_url: statusUrl }];
  const fetcher = vi.fn<typeof fetch>(async () => { const value = replies.shift(); if (value instanceof Error) throw value; if (value instanceof Response) return value; if (value === undefined) throw Error("Unexpected HTTP"); return Response.json(value); });
  const bytes = Buffer.alloc(32); bytes.writeUInt32BE(24); bytes.write("ftyp", 4);
  const download = vi.fn(async () => bytes);
  const client = createHiggsfieldTransport(config, fetcher, download);
  return { client, config, input, replies, fetcher, download, id, statusUrl, bytes, signal: () => AbortSignal.timeout(10000) };
}
describe("Higgsfield fixed-model network transport", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
  it("estimates exact parameters, submits with stable identity, polls and downloads without claiming final expense", async () => {
    const f = fixture(), estimate = await f.client.estimate(f.input, f.signal());
    expect(estimate.estimatedUsdMicros).toBe(123456); expect(estimate.signature).toHaveLength(64);
    const receipt = await f.client.submit(f.input, estimate, 150000, f.signal());
    f.replies.push({ request_id: f.id, status: "completed", video: { url: "https://cdn.example.com/output.mp4?signature=private" }, cost: 0 });
    expect(await f.client.poll(receipt, f.signal())).toEqual({ providerJobId: f.id, requestHash: estimate.requestHash, expense: "unverified", state: "completed", bytes: f.bytes });
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    const [estimateUrl, estimateInit] = f.fetcher.mock.calls[0], [submitUrl, submitInit] = f.fetcher.mock.calls[1];
    expect(estimateUrl).toBe("https://api.higgsfield.ai/estimate/bytedance/seedance-2.5/text-to-video");
    expect(submitUrl).toBe("https://api.higgsfield.ai/bytedance/seedance-2.5/text-to-video");
    expect(submitInit?.body).toBe(estimateInit?.body);
    expect(JSON.parse(String(submitInit?.body))).toEqual({ prompt: f.input.prompt, duration: 5, resolution: "720p", aspect_ratio: "9:16", output_format: "mp4", generate_audio: false });
    expect(submitInit).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", credentials: "omit", headers: { Authorization: `Key ${f.config.keyId}:${f.config.secret}`, "Idempotency-Key": f.input.operationId } });
    expect(f.download).toHaveBeenCalledWith("https://cdn.example.com/output.mp4?signature=private", ["cdn.example.com"], expect.any(AbortSignal));
    expect(JSON.stringify(receipt)).not.toContain(f.config.secret); expect(JSON.stringify(receipt)).not.toContain(f.input.prompt);
  });
  it("pins silent single-shot Kling parameters without unsupported options", () => {
    const f = fixture(), request = higgsfieldRequest({ ...f.input, model: "kling-3.0-standard-text", durationMs: 3000 });
    expect(request.path).toBe("/kling-video/v3.0/std/text-to-video");
    expect(request.body).toEqual({ prompt: f.input.prompt, duration: 3, aspect_ratio: "9:16", sound: "off", cfg_scale: 0.5, multi_shots: false });
  });
  it.each(["model", "duration", "fraction", "short", "long", "prompt", "empty", "operation", "extra"])("rejects invalid %s input before HTTP", async kind => {
    const f = fixture(), input: Record<string, unknown> = { ...f.input };
    if (kind === "model") input.model = "https://attacker.example";
    if (kind === "duration") input.durationMs = 3000;
    if (kind === "fraction") input.durationMs = 4250;
    if (kind === "short") input.durationMs = 1000;
    if (kind === "long") input.durationMs = 9000;
    if (kind === "prompt") input.prompt = "x".repeat(12001);
    if (kind === "empty") input.prompt = "   ";
    if (kind === "operation") input.operationId = "contains whitespace";
    if (kind === "extra") input.webhook = "https://attacker.example";
    await expect(f.client.estimate(input as HiggsfieldInput, f.signal())).rejects.toThrow("could not be verified"); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(["price", "request", "signature", "age", "future", "budget", "credentials"])("rejects %s mismatch before generation", async kind => {
    const f = fixture(), estimate = await f.client.estimate(f.input, f.signal());
    let client = f.client, ceiling = 150000;
    if (kind === "price") estimate.estimatedUsdMicros = 1;
    if (kind === "request") f.input.prompt = "Changed prompt";
    if (kind === "signature") estimate.signature = "0".repeat(64);
    if (kind === "age") { vi.useFakeTimers(); vi.setSystemTime(Date.now() + 600001); }
    if (kind === "future") { vi.useFakeTimers(); vi.setSystemTime(Date.now() - 1000); }
    if (kind === "budget") ceiling = 123455;
    if (kind === "credentials") client = createHiggsfieldTransport({ ...f.config, secret: "different-private-secret" }, f.fetcher, f.download);
    await expect(client.submit(f.input, estimate, ceiling, f.signal())).rejects.toThrow("could not be verified"); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([400, 401, 422, 429, 500, 503])("does not retry a submission HTTP %s or create another idempotency key", async status => {
    const f = fixture(), estimate = await f.client.estimate(f.input, f.signal()); f.replies[0] = new Response("private-provider-error", { status });
    await expect(f.client.submit(f.input, estimate, 150000, f.signal())).rejects.toThrow("could not be verified"); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["id", "url", "status", "network"])("rejects ambiguous %s submission without retrying", async kind => {
    const f = fixture(), estimate = await f.client.estimate(f.input, f.signal());
    f.replies[0] = kind === "network" ? Error("private") : { request_id: kind === "id" ? "../other" : f.id, status: kind === "status" ? "invented" : "queued", status_url: kind === "url" ? "https://attacker.example/status" : f.statusUrl };
    await expect(f.client.submit(f.input, estimate, 150000, f.signal())).rejects.toThrow("could not be verified"); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["providerJobId", "requestHash", "statusUrl", "model", "estimatedUsdMicros", "signature"])("rejects altered receipt %s before polling", async field => {
    const f = fixture(), estimate = await f.client.estimate(f.input, f.signal()), receipt = await f.client.submit(f.input, estimate, 150000, f.signal());
    const changed = { ...receipt, [field]: field === "estimatedUsdMicros" ? 1 : "altered" };
    await expect(f.client.poll(changed, f.signal())).rejects.toThrow("could not be verified"); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["queued", "in_progress", "failed", "nsfw", "canceled"])("keeps %s status separate from verified financial settlement", async status => {
    const f = fixture(), estimate = await f.client.estimate(f.input, f.signal()), receipt = await f.client.submit(f.input, estimate, 150000, f.signal());
    f.replies.push({ request_id: f.id, status });
    expect(await f.client.poll(receipt, f.signal())).toMatchObject({ state: ["queued", "in_progress"].includes(status) ? "pending" : status, expense: "unverified" });
    expect(f.download).not.toHaveBeenCalled();
  });
  it.each(["job", "missing-video", "host", "redirect-url", "signature", "oversized"])("rejects unsafe %s completion", async kind => {
    const f = fixture(), estimate = await f.client.estimate(f.input, f.signal()), receipt = await f.client.submit(f.input, estimate, 150000, f.signal());
    f.replies.push({ request_id: kind === "job" ? crypto.randomUUID() : f.id, status: "completed", ...(kind === "missing-video" ? {} : { video: { url: kind === "host" ? "https://attacker.example/file" : kind === "redirect-url" ? "http://cdn.example.com/file" : "https://cdn.example.com/file" } }) });
    if (kind === "signature") f.download.mockResolvedValue(Buffer.from("not a genuine MP4 file at all"));
    if (kind === "oversized") f.download.mockResolvedValue(Buffer.alloc(20 * 1024 * 1024 + 1));
    await expect(f.client.poll(receipt, f.signal())).rejects.toThrow("could not be verified");
    if (!["signature", "oversized"].includes(kind)) expect(f.download).not.toHaveBeenCalled();
  });
  it.each(["mime", "oversized", "length", "malformed", "price", "credits"])("rejects invalid %s estimate responses", async kind => {
    const f = fixture();
    f.replies[0] = kind === "mime" ? new Response("{}") : kind === "oversized" ? Response.json({ usd: "1", credits: "1", padding: "x".repeat(66000) }) : kind === "length" ? new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "1" } }) : kind === "malformed" ? new Response("{", { headers: { "Content-Type": "application/json" } }) : kind === "price" ? { usd: "NaN", credits: "1" } : { usd: "1", credits: "-1" };
    await expect(f.client.estimate(f.input, f.signal())).rejects.toThrow("could not be verified");
  });
  it("honors abort before HTTP and cancels an incomplete body read", async () => {
    const f = fixture(), before = AbortSignal.abort();
    await expect(f.client.estimate(f.input, before)).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
    const cancel = vi.fn(), controller = new AbortController();
    f.replies[0] = new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from("{")); }, cancel }), { headers: { "Content-Type": "application/json" } });
    const pending = f.client.estimate(f.input, controller.signal);
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toThrow("could not be verified"); expect(cancel).toHaveBeenCalledOnce();
  });
  it("does not register an incomplete adapter when credentials are added", () => {
    vi.stubEnv("HIGGSFIELD_API_KEY", "fixture-only"); vi.stubEnv("HIGGSFIELD_API_SECRET", "fixture-only-secret");
    expect(configuredShotAdapters()).toEqual([]);
  });
  it("requires fresh operator verification and rejects unsafe output host configuration", () => {
    const f = fixture();
    for (const config of [{ ...f.config, verifiedUntil: "2020-01-01T00:00:00Z" }, { ...f.config, verifiedUntil: new Date(Date.now() + 91 * 86400000).toISOString() }, { ...f.config, outputHosts: ["*.example.com"] }, { ...f.config, outputHosts: ["localhost"] }, { ...f.config, outputHosts: [] }]) expect(() => createHiggsfieldTransport(config, f.fetcher, f.download)).toThrow();
  });
  it.each([null, 1, "-1", "1e-3", "1.0000001", "80.000001", " 1", "01", "Infinity"])("rejects imprecise/unsafe USD value %s", value => expect(() => usdMicros(value)).toThrow());
  it("parses micro-USD without floating-point rounding", () => { expect(usdMicros("0.000001")).toBe(1); expect(usdMicros("0.123456")).toBe(123456); expect(usdMicros("80.000000")).toBe(80000000); expect(usdMicros("0")).toBe(0); });
});
