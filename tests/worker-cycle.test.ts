import { describe, expect, it, vi } from "vitest";
import { runWorkerCycle, type WorkerStep } from "../src/lib/production/cycle";

function fixture() {
  let time = 0, stopped = false;
  const hooks = { heartbeat: vi.fn(async () => true), stopping: () => stopped, failed: vi.fn(), now: () => time };
  return { hooks, advance: (n: number) => { time += n; }, stop: () => { stopped = true; } };
}
describe("fair production worker cycles", () => {
  it("runs social and intake after a continuously busy copy lane, once per cycle", async () => {
    const f = fixture(), calls: string[] = [];
    const steps = ["copy", "social-publish", "social-reconcile", "social-metrics", "website"].map(name => ({ name, run: vi.fn(async () => { calls.push(name); return true; }) }));
    for (let i = 0; i < 3; i++) expect(await runWorkerCycle(steps, f.hooks)).toEqual({ completed: steps.map(s => s.name), failed: [] });
    expect(calls).toEqual(Array.from({ length: 3 }, () => steps.map(s => s.name)).flat());
    for (const step of steps) expect(step.run).toHaveBeenCalledTimes(3);
  });
  it("isolates provider failures and never retries a failed write within the cycle", async () => {
    const f = fixture(), fail = vi.fn(async () => { throw Error("private-token-and-provider-payload"); }), following = vi.fn(async () => true);
    expect(await runWorkerCycle([{ name: "image", run: fail }, { name: "social", run: following }], f.hooks)).toEqual({ completed: ["social"], failed: ["image"] });
    expect(fail).toHaveBeenCalledOnce(); expect(following).toHaveBeenCalledOnce();
    expect(f.hooks.failed).toHaveBeenCalledExactlyOnceWith("image");
    expect(JSON.stringify(f.hooks.failed.mock.calls)).not.toContain("private-token");
  });
  it("keeps nonpaid reconciliation available while paid execution is disabled", async () => {
    const f = fixture(); f.hooks.heartbeat.mockResolvedValue(false);
    const paid = vi.fn(async () => true), reconcile = vi.fn(async () => true);
    const steps = [{ name: "copy", enabled: (enabled: boolean) => enabled, run: paid }, { name: "reconcile", run: reconcile }];
    expect(await runWorkerCycle(steps, f.hooks)).toEqual({ completed: ["reconcile"], failed: [] });
    expect(paid).not.toHaveBeenCalled(); expect(reconcile).toHaveBeenCalledOnce();
  });
  it("rechecks readiness between long lanes without starting a background health timer", async () => {
    const f = fixture(), order: string[] = [];
    f.hooks.heartbeat.mockImplementation(async () => { order.push("heartbeat"); return true; });
    const steps = ["brand", "image", "copy"].map(name => ({ name, run: async () => { order.push(name); f.advance(60000); } }));
    await runWorkerCycle(steps, f.hooks);
    expect(order).toEqual(["heartbeat", "brand", "heartbeat", "image", "heartbeat", "copy"]);
  });
  it("does not perform redundant heartbeat writes for short lanes", async () => {
    const f = fixture();
    await runWorkerCycle(Array.from({ length: 20 }, (_, i) => ({ name: String(i), run: async () => { f.advance(500); } })), f.hooks);
    expect(f.hooks.heartbeat).toHaveBeenCalledOnce();
  });
  it("observes disabled paid execution after a readiness refresh", async () => {
    const f = fixture(); f.hooks.heartbeat.mockResolvedValueOnce(true).mockResolvedValue(false);
    const paid = vi.fn(async () => true), independent = vi.fn(async () => true);
    await runWorkerCycle([{ name: "first", run: async () => { f.advance(30000); } }, { name: "paid", enabled: enabled => enabled, run: paid }, { name: "social", run: independent }], f.hooks);
    expect(paid).not.toHaveBeenCalled(); expect(independent).toHaveBeenCalledOnce();
  });
  it("stops before any job when readiness cannot be established", async () => {
    const f = fixture(); f.hooks.heartbeat.mockRejectedValue(Error("database unavailable"));
    const run = vi.fn(async () => true);
    await expect(runWorkerCycle([{ name: "copy", run }], f.hooks)).rejects.toThrow("database unavailable");
    expect(run).not.toHaveBeenCalled(); expect(f.hooks.failed).not.toHaveBeenCalled();
  });
  it("stops later lanes after a mid-cycle readiness failure", async () => {
    const f = fixture(); f.hooks.heartbeat.mockResolvedValueOnce(true).mockRejectedValue(Error("lost readiness"));
    const next = vi.fn(async () => true);
    await expect(runWorkerCycle([{ name: "first", run: async () => { f.advance(30000); } }, { name: "next", run: next }], f.hooks)).rejects.toThrow();
    expect(next).not.toHaveBeenCalled();
  });
  it("does not start work or renew readiness after shutdown", async () => {
    const f = fixture(); f.stop(); const run = vi.fn(async () => true);
    expect(await runWorkerCycle([{ name: "copy", run }], f.hooks)).toEqual({ completed: [], failed: [] });
    expect(run).not.toHaveBeenCalled(); expect(f.hooks.heartbeat).not.toHaveBeenCalled();
  });
  it("checks shutdown again when an in-flight heartbeat finishes", async () => {
    const f = fixture(); f.hooks.heartbeat.mockImplementation(async () => { f.stop(); return true; });
    const run = vi.fn(async () => true); await runWorkerCycle([{ name: "copy", run }], f.hooks);
    expect(run).not.toHaveBeenCalled();
  });
  it("finishes one in-flight lane but starts nothing else after shutdown", async () => {
    const f = fixture(), later = vi.fn(async () => true);
    expect(await runWorkerCycle([{ name: "inflight", run: async () => { f.stop(); } }, { name: "later", run: later }], f.hooks)).toEqual({ completed: ["inflight"], failed: [] });
    expect(later).not.toHaveBeenCalled();
  });
  it("never overlaps mutating lanes", async () => {
    const f = fixture(); let active = 0;
    const steps: WorkerStep[] = Array.from({ length: 4 }, (_, i) => ({ name: String(i), run: async () => {
      expect(active++).toBe(0); await new Promise(resolve => setTimeout(resolve, 2)); expect(--active).toBe(0);
    } }));
    await runWorkerCycle(steps, f.hooks); expect(active).toBe(0);
  });
  it("isolates a failing configuration gate without invoking its lane", async () => {
    const f = fixture(), run = vi.fn(async () => true), other = vi.fn(async () => true);
    await runWorkerCycle([{ name: "gated", enabled: () => { throw Error("private configuration"); }, run }, { name: "other", run: other }], f.hooks);
    expect(run).not.toHaveBeenCalled(); expect(other).toHaveBeenCalledOnce(); expect(f.hooks.failed).toHaveBeenCalledExactlyOnceWith("gated");
  });
});
