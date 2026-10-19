import { runWorkerCycle, type WorkerStep } from "./cycle";

export type WorkerGroup = { name: string; steps: readonly WorkerStep[] };
export const WORKER_POLL_MS = 5000;

export function validateWorkerGroups(groups: readonly WorkerGroup[]) {
  const names = new Set<string>(), lanes = new Set<string>();
  if (!groups.length || groups.length > 8) throw Error("Invalid worker group count");
  for (const group of groups) {
    if (!/^[a-z-]+$/.test(group.name) || names.has(group.name) || !group.steps.length) throw Error("Invalid worker group");
    names.add(group.name);
    for (const step of group.steps) {
      if (lanes.has(step.name)) throw Error("A worker lane cannot belong to multiple groups");
      lanes.add(step.name);
    }
  }
}

// Readiness is the oldest progress checkpoint, not the busiest group's heartbeat.
// No timer races or cancels a mutation, and a stuck group cannot be hidden by peers.
export class GroupReadiness {
  private progress: Map<string, number>;
  private lastAttemptAt = -Infinity;
  private lastSuccessAt = -Infinity;
  private enabled = false;
  private failed = false;
  private pending: Promise<boolean> | undefined;
  constructor(names: readonly string[], private hooks: {
    write: (oldestProgressAt: Date) => Promise<boolean>;
    stopping: () => boolean;
    ttlMs: number;
    now?: () => number;
  }) {
    if (!names.length || new Set(names).size !== names.length) throw Error("Invalid readiness groups");
    this.progress = new Map(names.map(name => [name, this.now()]));
  }
  private now() { return (this.hooks.now ?? Date.now)(); }
  private oldest() { return Math.min(...this.progress.values()); }
  healthy() {
    const now = this.now(), age = now - Math.min(this.oldest(), this.lastSuccessAt);
    return !this.hooks.stopping() && !this.failed && age >= 0 && age < this.hooks.ttlMs;
  }
  async checkpoint(name: string) {
    if (!this.progress.has(name)) throw Error("Unknown worker group");
    if (this.hooks.stopping()) throw Error("Worker is stopping");
    const now = this.now();
    this.progress.set(name, now);
    if (this.pending) return this.pending;
    if (now >= this.lastAttemptAt && now - this.lastAttemptAt < WORKER_POLL_MS) {
      if (this.failed) throw Error("Worker readiness unavailable");
      return this.enabled;
    }
    this.lastAttemptAt = now;
    // One write shared by all groups; timestamp captured before any asynchronous work.
    this.pending = Promise.resolve().then(() => this.hooks.write(new Date(this.oldest()))).then(enabled => {
      this.lastSuccessAt = now; this.failed = false; this.enabled = enabled;
      return enabled;
    }).catch(() => {
      this.lastSuccessAt = -Infinity; this.failed = true; this.enabled = false;
      throw Error("Worker readiness unavailable");
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async drain() { await this.pending?.catch(() => {}); }
}

export async function runWorkerGroups(groups: readonly WorkerGroup[], hooks: {
  readiness: GroupReadiness;
  stopping: () => boolean;
  sleep: () => Promise<void>;
  failed: (group: string, lane: string) => void;
  readinessFailed: (group: string) => void;
}) {
  validateWorkerGroups(groups);
  await Promise.all(groups.map(async group => {
    while (!hooks.stopping()) {
      try {
        await runWorkerCycle(group.steps, {
          heartbeat: () => hooks.readiness.checkpoint(group.name),
          stopping: hooks.stopping,
          failed: lane => hooks.failed(group.name, lane),
        });
      } catch { hooks.readinessFailed(group.name); }
      if (!hooks.stopping()) await hooks.sleep();
    }
  }));
  await hooks.readiness.drain();
}
