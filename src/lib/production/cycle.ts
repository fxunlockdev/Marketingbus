export type WorkerStep = {
  name: string;
  enabled?: (paidEnabled: boolean) => boolean;
  run: () => Promise<unknown>;
};
export type CycleHooks = {
  heartbeat: () => Promise<boolean>;
  stopping: () => boolean;
  failed: (name: string) => void;
  now?: () => number;
};

// One bounded attempt per lane per cycle. A busy or failed lane cannot skip later
// lanes. This is not a retry engine: each worker owns its leases and recovery.
// Never race an unfinished mutation against a timer and then start another one.
export async function runWorkerCycle(steps: readonly WorkerStep[], hooks: CycleHooks) {
  const now = hooks.now ?? Date.now;
  let paidEnabled = false, refreshedAt = -Infinity;
  const completed: string[] = [], failed: string[] = [];
  for (const step of steps) {
    if (hooks.stopping()) break;
    if (now() - refreshedAt >= 30000) {
      // A database/readiness failure stops this cycle, unlike a lane failure.
      // No background timer can keep a hung worker falsely healthy.
      paidEnabled = await hooks.heartbeat();
      refreshedAt = now();
    }
    if (hooks.stopping()) break;
    try {
      if (step.enabled && !step.enabled(paidEnabled)) continue;
      await step.run();
      completed.push(step.name);
    } catch {
      failed.push(step.name);
      hooks.failed(step.name); // Code-owned label only, never raw provider errors.
    }
  }
  return { completed, failed };
}
