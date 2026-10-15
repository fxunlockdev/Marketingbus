"use client";
import { useEffect, useState, useId } from "react";
import { useRouter } from "next/navigation";
type Policy = { enabled: boolean; mode: string; maxItems: number; creditsPerWeek: number; weekday: number; hourUTC: number; version: number };
const initial: Policy = { enabled: false, mode: "PLAN", maxItems: 4, creditsPerWeek: 0, weekday: 1, hourUTC: 9, version: 0 };
export function WorkflowControls({ businessId }: { businessId: string }) {
  const router = useRouter(), [policy, setPolicy] = useState<Policy>(initial), [independent, setIndependent] = useState(false), [cycles, setCycles] = useState<{ id: string; periodKey: string; status: string; creditsAuthorized: number; errorCode: string | null }[]>([]), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  async function load() {
    const responses = await Promise.all([fetch(`/api/businesses/${businessId}/planning`), fetch(`/api/businesses/${businessId}/approvals`)]);
    const data = await Promise.all(responses.map(r => r.json()));
    if (responses.some(r => !r.ok)) throw Error("Unable to load workflow settings.");
    setPolicy(data[0].policy ?? initial); setCycles(data[0].cycles); setIndependent(data[1].independent); setLoaded(true);
  }
  useEffect(() => { void load().catch(e => setError(e.message)); }, [businessId]);
  async function save(path: string, body: unknown) {
    setBusy(true); setError(""); setMessage("");
    try { const r = await fetch(`/api/businesses/${businessId}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw Error(data.error); await load(); router.refresh(); setMessage("Workflow settings saved."); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to save."); } finally { setBusy(false); }
  }
  return <div className="production-list" aria-busy={busy}>
    <p role="alert" className="form-error">{error}</p><p role="status">{message}</p>
    <section className="panel"><h2>Independent approval</h2><p>Require an owner or administrator other than the author to approve copy and compositions. Changing this policy revokes existing approvals and pending schedules. Two administrators are required before enabling it.</p>
      <label className="checkbox-label"><input type="checkbox" checked={independent} onChange={e => setIndependent(e.target.checked)} />Require a different approver</label>
      <button className="button secondary" disabled={busy || !loaded} onClick={() => save("approvals", { action: "policy", independent })}>Save approval policy</button>
    </section>
    <section className="panel"><h2>Weekly planning and draft autopilot</h2><p>Creates one bounded plan per UTC week. Draft mode can reserve credits and generate copy; it never approves or publishes. Changing the policy stops unaccepted work but cannot cancel jobs already authorized. Missing funds or invalid configuration stops the cycle without automatic retries.</p>
      <form onSubmit={e => { e.preventDefault(); const { enabled, mode, maxItems, creditsPerWeek, weekday, hourUTC, version } = policy; void save("planning", { enabled, mode, maxItems, creditsPerWeek, weekday, hourUTC, version }); }}>
        <label className="checkbox-label"><input type="checkbox" checked={policy.enabled} onChange={e => setPolicy(p => ({ ...p, enabled: e.target.checked }))} />Enable recurring work for this business</label>
        <label>Weekly mode<select value={policy.mode} onChange={e => setPolicy(p => ({ ...p, mode: e.target.value }))}><option value="PLAN">Planning only · no model calls</option><option value="DRAFTS">Plan and generate copy drafts · spends credits</option></select></label>
        <label>Maximum planned items<input type="number" min={1} max={12} required value={policy.maxItems} onChange={e => setPolicy(p => ({ ...p, maxItems: Number(e.target.value) }))} /></label>
        <label>Weekly credit ceiling<input type="number" min={0} max={8000} required value={policy.creditsPerWeek} onChange={e => setPolicy(p => ({ ...p, creditsPerWeek: Number(e.target.value) }))} /></label>
        <label>Day of week (UTC)<select value={policy.weekday} onChange={e => setPolicy(p => ({ ...p, weekday: Number(e.target.value) }))}>{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>
        <label>Hour (UTC, 0–23)<input type="number" min={0} max={23} required value={policy.hourUTC} onChange={e => setPolicy(p => ({ ...p, hourUTC: Number(e.target.value) }))} /></label>
        <button className="button dark" disabled={busy || !loaded}>Save recurring authorization</button>
      </form>
      <p className="muted">A changed brand or removed administrator pauses recurring work. Video items require separate direction and are not automatically generated here.</p>
    </section>
    <section className="panel"><h2>Weekly runs</h2>{!cycles.length && <p>No recurring cycles yet.</p>}<ul>{cycles.map(c => <li key={c.id}>Week of {c.periodKey} · {c.status} · {c.creditsAuthorized} credits authorized {c.errorCode && `· ${c.errorCode}`}</li>)}</ul></section>
  </div>;
}
type Comment = { id: string; body: string; blocking: boolean; resolvedAt: string | null; revision: { version: number } };
export function RevisionDiscussion({ businessId, itemId, version }: { businessId: string; itemId: string; version: number }) {
  const uid = useId(), router = useRouter(), [comments, setComments] = useState<Comment[]>([]), [body, setBody] = useState(""), [blocking, setBlocking] = useState(false), [error, setError] = useState(""), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => { const abort = new AbortController(); void fetch(`/api/businesses/${businessId}/approvals?itemId=${encodeURIComponent(itemId)}`, { signal: abort.signal }).then(async r => { const d = await r.json(); if (!r.ok) throw Error(d.error); if (!abort.signal.aborted) setComments(d.comments); }).catch(e => { if (!abort.signal.aborted) setError(e.message); }); return () => abort.abort(); }, [businessId, itemId, refresh]);
  async function act(data: unknown) {
    setBusy(true); setError("");
    try { const r = await fetch(`/api/businesses/${businessId}/approvals`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }); const d = await r.json(); if (!r.ok) throw Error(d.error); setBody(""); setRefresh(n => n + 1); router.refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Unable to save comment."); } finally { setBusy(false); }
  }
  return <section aria-busy={busy}><h3>Review discussion</h3><p role="alert" className="form-error" id={`${uid}-error`}>{error}</p><p>Blocking comments revoke approval and scheduling. Resolving a comment does not re-approve the creative.</p><form onSubmit={e => { e.preventDefault(); void act({ action: "comment", itemId, version, body, blocking }); }}>
    <label htmlFor={`${uid}-comment`}>Comment on version {version}</label><textarea id={`${uid}-comment`} required minLength={2} maxLength={2000} value={body} onChange={e => setBody(e.target.value)} aria-describedby={`${uid}-error`} />
    <label className="checkbox-label"><input type="checkbox" checked={blocking} onChange={e => setBlocking(e.target.checked)} />Block approval until resolved</label><button className="button secondary" disabled={busy}>Add review comment</button>
  </form><ul>{comments.map(c => <li key={c.id}><p>Version {c.revision.version} · {c.resolvedAt ? "Resolved" : c.blocking ? "Blocking" : "Note"}</p><p>{c.body}</p>{!c.resolvedAt && <button className="text-button" disabled={busy} onClick={() => act({ action: "resolve", commentId: c.id })}>Resolve comment</button>}</li>)}</ul></section>;
}
