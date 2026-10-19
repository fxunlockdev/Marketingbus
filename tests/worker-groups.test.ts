import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupReadiness, runWorkerGroups, validateWorkerGroups, WORKER_POLL_MS, type WorkerGroup } from "../src/lib/production/groups";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(names = ["production", "publishing"]) {
  let stopped = false;
  const write = vi.fn(async (_at: Date) => true);
  const readiness = new GroupReadiness(names, { write, stopping: () => stopped, ttlMs: 120000 });
  return { write, readiness, stop: () => { stopped = true; }, stopping: () => stopped };
}
afterEach(() => vi.useRealTimers());
describe("bounded independent worker groups", () => {
  it("rejects empty, repeated groups and duplicated workflow ownership", () => {
    const step = { name: "copy", run: async () => true };
    expect(() => validateWorkerGroups([])).toThrow();
    expect(() => validateWorkerGroups([{ name: "production", steps: [] }])).toThrow();
    expect(() => validateWorkerGroups([{ name: "production", steps: [step] }, { name: "production", steps: [{ ...step, name: "other" }] }])).toThrow();
    expect(() => validateWorkerGroups([{ name: "production", steps: [step] }, { name: "other", steps: [step] }])).toThrow();
    expect(() => validateWorkerGroups(Array.from({ length: 9 }, () => ({ name: "work", steps: [step] })))).toThrow();
  });
  it("coalesces concurrent readiness writes and prevents database polling multiplication", async () => {
    vi.useFakeTimers(); const f = fixture(), wait = deferred<boolean>(); f.write.mockImplementation(() => wait.promise);
    const first = f.readiness.checkpoint("production"), second = f.readiness.checkpoint("publishing");
    await Promise.resolve(); expect(f.write).toHaveBeenCalledOnce(); expect(f.readiness.healthy()).toBe(false);
    wait.resolve(true); expect(await first).toBe(true); expect(await second).toBe(true);
    expect(f.readiness.healthy()).toBe(true);
    await f.readiness.checkpoint("publishing"); expect(f.write).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(WORKER_POLL_MS);
    await f.readiness.checkpoint("publishing"); expect(f.write).toHaveBeenCalledTimes(2);
  });
  it("does not refresh aggregate health or persisted timestamp past a stalled group", async () => {
    vi.useFakeTimers(); const f = fixture(), start = Date.now();
    await f.readiness.checkpoint("production");
    for (let n = 0; n < 25; n++) { await vi.advanceTimersByTimeAsync(5000); await f.readiness.checkpoint("publishing"); }
    expect(f.readiness.healthy()).toBe(false);
    expect(f.write.mock.calls.at(-1)![0].getTime()).toBe(start);
    await f.readiness.checkpoint("production");
    expect(f.readiness.healthy()).toBe(true);
    await vi.advanceTimersByTimeAsync(5000); await f.readiness.checkpoint("publishing");
    expect(f.write.mock.calls.at(-1)![0].getTime()).toBe(start + 125000);
  });
  it("a hung readiness write cannot keep local health alive and cannot overlap another write", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.readiness.checkpoint("production");
    const wait = deferred<boolean>(); f.write.mockImplementation(() => wait.promise);
    await vi.advanceTimersByTimeAsync(5000); const first = f.readiness.checkpoint("publishing");
    await vi.advanceTimersByTimeAsync(125000); const second = f.readiness.checkpoint("production");
    expect(f.readiness.healthy()).toBe(false); expect(f.write).toHaveBeenCalledTimes(2);
    wait.resolve(true); await Promise.all([first, second]);
    expect(f.readiness.healthy()).toBe(false); // Completion time is not the checkpoint time.
  });
  it("readiness failures are closed, coalesced and recover without leaking raw errors", async () => {
    vi.useFakeTimers(); const f = fixture(); f.write.mockRejectedValue(Error("secret-database-url"));
    await expect(f.readiness.checkpoint("production")).rejects.toThrow("Worker readiness unavailable");
    await expect(f.readiness.checkpoint("publishing")).rejects.not.toThrow("secret");
    expect(f.write).toHaveBeenCalledOnce(); expect(f.readiness.healthy()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000); f.write.mockResolvedValue(false);
    expect(await f.readiness.checkpoint("production")).toBe(false); expect(f.readiness.healthy()).toBe(true);
  });
  it("rejects unknown groups and stops renewing after shutdown, draining an existing write", async () => {
    const f = fixture(), wait = deferred<boolean>(); f.write.mockImplementation(() => wait.promise);
    await expect(f.readiness.checkpoint("unknown")).rejects.toThrow("Unknown");
    const pending = f.readiness.checkpoint("production"); await Promise.resolve(); f.stop();
    await expect(f.readiness.checkpoint("publishing")).rejects.toThrow("stopping");
    let drained = false; const drain = f.readiness.drain().then(() => { drained = true; }); await Promise.resolve(); expect(drained).toBe(false);
    wait.resolve(true); await pending; await drain; expect(drained).toBe(true); expect(f.readiness.healthy()).toBe(false); expect(f.write).toHaveBeenCalledOnce();
  });
  it("continues publishing and metrics while media is blocked; shutdown awaits media without starting the next paid lane", async () => {
    vi.useFakeTimers(); const f = fixture(["production", "publishing", "metrics"]), wait = deferred<boolean>();
    const media = vi.fn(() => wait.promise), copy = vi.fn(async () => true), publish = vi.fn(async () => true), metrics = vi.fn(async () => true);
    const groups: WorkerGroup[] = [
      { name: "production", steps: [{ name: "media", run: media }, { name: "copy", run: copy }] },
      { name: "publishing", steps: [{ name: "publish", run: publish }] },
      { name: "metrics", steps: [{ name: "metrics", run: metrics }] },
    ];
    let finished = false;
    const run = runWorkerGroups(groups, { readiness: f.readiness, stopping: f.stopping, sleep: () => new Promise(done => setTimeout(done, 5000)), failed: vi.fn(), readinessFailed: vi.fn() }).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(15000);
    expect(media).toHaveBeenCalledOnce(); expect(copy).not.toHaveBeenCalled(); expect(publish).toHaveBeenCalledTimes(4); expect(metrics).toHaveBeenCalledTimes(4);
    f.stop(); await vi.advanceTimersByTimeAsync(5000); expect(finished).toBe(false);
    wait.resolve(true); await run;
    expect(finished).toBe(true); expect(copy).not.toHaveBeenCalled(); expect(media).toHaveBeenCalledOnce(); expect(publish).toHaveBeenCalledTimes(4);
  });
  it("keeps paid lanes sequential and cannot create an unbounded group loop", async () => {
    vi.useFakeTimers(); const f = fixture(["production"]); let active = 0, maxActive = 0, calls = 0;
    const runLane = async () => { maxActive = Math.max(maxActive, ++active); await new Promise(done => setTimeout(done, 100)); --active; ++calls; };
    const run = runWorkerGroups([{ name: "production", steps: ["image", "copy", "shot"].map(name => ({ name, run: runLane })) }], { readiness: f.readiness, stopping: f.stopping, sleep: () => new Promise(done => setTimeout(done, 5000)), failed: vi.fn(), readinessFailed: vi.fn() });
    await vi.advanceTimersByTimeAsync(10000); f.stop(); await vi.advanceTimersByTimeAsync(6000); await run;
    expect(maxActive).toBe(1); expect(active).toBe(0); expect(calls).toBe(6);
  });
  it("keeps failures inside their group and resumes readiness only on a later bounded cycle", async () => {
    vi.useFakeTimers(); const f = fixture(); f.write.mockRejectedValueOnce(Error("private"));
    const failed = vi.fn(), readinessFailed = vi.fn(), paid = vi.fn(async () => { throw Error("private-provider-payload"); }), publish = vi.fn(async () => true);
    const run = runWorkerGroups([{ name: "production", steps: [{ name: "image", run: paid }] }, { name: "publishing", steps: [{ name: "publish", run: publish }] }], { readiness: f.readiness, stopping: f.stopping, sleep: () => new Promise(done => setTimeout(done, 5000)), failed, readinessFailed });
    await vi.advanceTimersByTimeAsync(4999); expect(paid).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled(); expect(f.write).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(paid).toHaveBeenCalledOnce(); expect(publish).toHaveBeenCalledOnce();
    f.stop(); await vi.advanceTimersByTimeAsync(5000); await run;
    expect(failed).toHaveBeenCalledExactlyOnceWith("production", "image"); expect(readinessFailed.mock.calls).toEqual([["production"], ["publishing"]]);
  });
});
