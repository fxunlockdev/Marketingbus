"use client";
import { useEffect, useState } from "react";
type Job = { id: string; storyboardId: string; shotId: string; shotLabel: string; durationMs: number; status: string; credits: number; expiresAt: string; output: { id: string; status: string } | null };
type Data = { canEdit: boolean; integrationAvailable: boolean; jobs: Job[] };
const status: Record<string, string> = { OFFERED: "Quote · no credits held", QUEUED: "Queued · credits held", RUNNING: "Preparing · credits held", SUBMITTING: "Submitting once · credits held", POLLING: "Supplier processing · credits held", INGESTING: "Verifying private footage · credits held", READY: "Generation complete · check footage review", FAILED: "No deliverable · hold released", CANCELLED: "Cancelled before submission", NEEDS_RECONCILIATION: "Outcome uncertain · hold retained for operator review" };
export function GeneratedShotJobs({ businessId, board, dirty, onRefresh }: { businessId: string; board?: { id: string; status: string; document: { shots: { id: string; label: string; asset: unknown; clip?: unknown }[] } }; dirty: boolean; onRefresh: () => Promise<void> }) {
  const [data, setData] = useState<Data | null>(null), [shotId, setShotId] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState(""), [rights, setRights] = useState<Record<string, boolean>>({});
  const endpoint = `/api/businesses/${businessId}/video-generations`;
  async function refresh(signal?: AbortSignal) { const r = await fetch(endpoint, { signal }), d = await r.json(); if (!r.ok) throw Error(d.error); if (!signal?.aborted) setData(d); }
  useEffect(() => { const a = new AbortController(); void refresh(a.signal).catch(e => { if (!a.signal.aborted) setError(e.message); }); return () => a.abort(); }, [businessId]);
  useEffect(() => { setShotId(""); setRights({}); }, [board?.id]);
  async function act(body?: unknown) {
    setBusy(true); setError(""); setMessage("");
    try {
      if (body) { const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (!r.ok) throw Error((await r.json()).error); }
      await refresh(); await onRefresh(); setRights({}); setMessage("Generated-shot status refreshed. Footage still needs human review; nothing was published.");
    } catch (e) { setError(e instanceof Error ? e.message : "Status unavailable. Refresh before taking another action."); }
    finally { setBusy(false); }
  }
  const editable = !!data?.canEdit && !busy && !dirty;
  return <section className="panel" aria-label="Generated shot production" aria-busy={busy}>
    <h2>Generate supporting footage</h2>
    <p>Start from an approved, saved scene—not a free-form prompt. Quotes show a credit ceiling. Credits remain held through supplier processing and private normalization; only usable footage settles the charge. Review rights, likeness, accuracy and continuity before using the result.</p>
    {!data?.integrationAvailable && <p>Generated video is awaiting a verified provider integration. No generation can be purchased here yet. Uploaded footage and local motion cards remain separate.</p>}
    <p id="shot-generation-help">This lane supports empty scenes only; it does not redraw brand assets or edit existing video. Save edits and approve the whole storyboard first. Reference-led revisions, voiceover and music remain unavailable.</p>
    <form onSubmit={e => { e.preventDefault(); void act({ action: "quote", storyboardId: board?.id, shotId }); }}>
      <label>Approved scene for generation<select value={shotId} onChange={e => setShotId(e.target.value)} disabled={!editable || board?.status !== "APPROVED"} aria-describedby="shot-generation-help"><option value="">Choose an empty scene</option>{board?.document.shots.filter(s => !s.asset && !s.clip).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
      <button className="button" disabled={!editable || !data?.integrationAvailable || board?.status !== "APPROVED" || !shotId}>Get shot quote · no charge</button>
    </form>
    <button type="button" className="button" disabled={busy || dirty} onClick={() => void act()}>Refresh generated-shot status</button>
    {dirty && <p>Save storyboard edits before requesting or authorizing footage.</p>}
    {!data?.canEdit && <p>Workspace editing access is required to authorize or cancel generation.</p>}
    <p role="alert" className="form-error">{error}</p><p role="status">{message}</p>
    {data?.jobs.length === 0 && <p>No generated-shot jobs yet.</p>}
    {data?.jobs.map(job => <article className="review-card" key={job.id} aria-label={`Generation ${job.shotLabel}`}>
      <h3>{job.shotLabel} · {(job.durationMs / 1000).toFixed(2)} seconds</h3>
      <p>{status[job.status] ?? "Status requires operator review"} · quote ceiling {job.credits} credits</p>
      {job.storyboardId !== board?.id && <p>From another saved storyboard version.</p>}
      {job.status === "OFFERED" && <>
        <p>Quote expires {new Date(job.expiresAt).toLocaleString()}. Accepting reserves up to {job.credits} credits for one supplier submission.</p>
        <label><input type="checkbox" checked={!!rights[job.id]} disabled={!editable || !data.integrationAvailable} onChange={e => setRights({ ...rights, [job.id]: e.target.checked })} />I authorize this supporting footage and will review its rights, likeness and accuracy before use.</label>
        <button type="button" className="button dark" disabled={!editable || !data.integrationAvailable || !rights[job.id] || job.storyboardId !== board?.id} onClick={() => void act({ action: "accept", generationId: job.id, rightsConfirmed: true })}>Reserve {job.credits} credits · {job.shotLabel}</button>
      </>}
      {["OFFERED", "QUEUED", "RUNNING"].includes(job.status) && <button type="button" className="button" disabled={!editable} onClick={() => void act({ action: "cancel", generationId: job.id })}>Cancel generation · {job.shotLabel}</button>}
      {job.status === "NEEDS_RECONCILIATION" && <p>Do not retry. An operator must verify the final supplier expense. The app will not submit this job again.</p>}
      {job.status === "READY" && <p>Footage state: {job.output?.status.toLowerCase() ?? "unavailable"}. Preview and approve eligible footage in the private library, then select it in your storyboard and review the new version.</p>}
    </article>)}
  </section>;
}
