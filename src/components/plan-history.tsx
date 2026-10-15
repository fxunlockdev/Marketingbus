"use client";
import { useEffect, useState } from "react";
import type { ProductionItemView } from "./production-card";
export type PlanSummary = { id: string; title: string; status: string; brandVersion: number; createdAt: string };
export type PlanView = PlanSummary & { items: ProductionItemView[] };
export function PlanHistory({ businessId, selectedId, busy, onChoose }: { businessId: string; selectedId?: string; busy: boolean; onChoose: (id: string) => void }) {
  const [cursor, setCursor] = useState(""), [plans, setPlans] = useState<(PlanSummary & { _count: { items: number } })[]>([]), [next, setNext] = useState<string | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError("");
    void (async () => {
      try {
        const response = await fetch(`/api/businesses/${businessId}/plans${cursor ? `?before=${encodeURIComponent(cursor)}` : ""}`, { signal: abort.signal });
        const data = await response.json(); if (!response.ok) throw Error(data.error);
        if (!abort.signal.aborted) { setPlans(data.plans); setNext(data.nextCursor); }
      } catch (e) { if (!abort.signal.aborted) { setPlans([]); setNext(null); setError(e instanceof Error ? e.message : "Unable to load history."); } }
      finally { if (!abort.signal.aborted) setLoading(false); }
    })(); return () => abort.abort();
  }, [businessId, cursor, refresh]);
  return <section className="panel" aria-busy={loading}>
    <h2>Plan history</h2><p>Open an earlier plan to inspect its latest saved copy. Current-brand plans can continue through review and production; superseded plans are read-only. Opening a plan never generates or publishes content.</p>
    <p role="alert" className="form-error">{error}</p>
    {loading ? <p role="status">Loading plan history…</p> : plans.length ? <ul>{plans.map(plan => <li key={plan.id}>
      <button className="text-button" disabled={busy} aria-current={selectedId === plan.id ? "true" : undefined} onClick={() => onChoose(plan.id)}>Open {plan.title}</button>
      <p>{plan.createdAt.slice(0, 10)} · brand version {plan.brandVersion} · {plan.status.toLowerCase()} · {plan._count.items} creatives{selectedId === plan.id ? " · selected" : ""}</p>
    </li>)}</ul> : !error && <p>No saved plans yet.</p>}
    <div className="tag-row"><button className="button" disabled={loading || busy} onClick={() => { setCursor(""); setRefresh(v => v + 1); }}>Latest plans</button><button className="button" disabled={loading || busy || !next} onClick={() => setCursor(next!)}>Older plans</button></div>
  </section>;
}
export function HistoricalCreative({ item }: { item: ProductionItemView }) {
  const copy = item.revisions[0];
  return <section className="panel"><h2>{item.title}</h2><p>{item.channel} · {item.format} · read-only</p>{copy ? <>
    <p>Copy version {copy.version} · {copy.status.toLowerCase()}</p><h3>{copy.content.headline}</h3><p className="preserve-lines">{copy.content.caption}</p><p>{copy.content.cta}</p>
    <details><summary>Saved direction and feedback</summary><p>{copy.content.visualDirection}</p><p>{copy.content.rationale}</p><p>{copy.feedback}</p></details>
  </> : <p>No generated copy was saved for this creative.</p>}</section>;
}
