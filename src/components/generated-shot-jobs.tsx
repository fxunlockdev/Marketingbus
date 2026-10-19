"use client";
import { useEffect, useRef, useState } from "react";
type Brief = { version: 1; direction: string; revisions: { parentId: string; feedback: string }[] };
type Job = { id: string; storyboardId: string; itemId: string; shotId: string; shotLabel: string; durationMs: number; status: string; credits: number; expiresAt: string; revisionOfId: string | null; creativeBrief: Brief; output: { id: string; status: string } | null };
type Data = { canEdit: boolean; integrationAvailable: boolean; jobs: Job[] };
const status: Record<string, string> = { OFFERED: "Quote · no credits held", QUEUED: "Queued · credits held", RUNNING: "Preparing · credits held", SUBMITTING: "Submitting once · credits held", POLLING: "Supplier processing · credits held", INGESTING: "Verifying private footage · credits held", READY: "Generation complete · check footage review", FAILED: "No deliverable · hold released", CANCELLED: "Cancelled before submission", NEEDS_RECONCILIATION: "Outcome uncertain · hold retained for operator review" };
export function GeneratedShotJobs({ businessId, board, dirty, onRefresh }: { businessId: string; board?: { id: string; itemId: string; status: string; document: { shots: { id: string; label: string; asset: unknown; clip?: { id: string } | null }[] } }; dirty: boolean; onRefresh: () => Promise<void> }) {
  const [data, setData] = useState<Data | null>(null), [shotId, setShotId] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState(""), [rights, setRights] = useState<Record<string, boolean>>({});
  const [direction, setDirection] = useState(""), [revisionOfId, setRevisionOfId] = useState(""), [feedback, setFeedback] = useState("");
  const notice = useRef<HTMLParagraphElement>(null), problem = useRef<HTMLParagraphElement>(null);
  const endpoint = `/api/businesses/${businessId}/video-generations`;
  async function refresh(signal?: AbortSignal) { const r = await fetch(endpoint, { signal }), d = await r.json(); if (!r.ok) throw Error(d.error); if (!signal?.aborted) setData(d); }
  useEffect(() => { const a = new AbortController(); void refresh(a.signal).catch(e => { if (!a.signal.aborted) setError(e.message); }); return () => a.abort(); }, [businessId]);
  useEffect(() => { setShotId(""); setRights({}); setDirection(""); setRevisionOfId(""); setFeedback(""); }, [board?.id]);
  useEffect(() => { if (error) problem.current?.focus(); else if (message) notice.current?.focus(); }, [error, message]);
  async function act(body?: unknown) {
    setBusy(true); setError(""); setMessage("");
    try {
      if (body) { const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (!r.ok) throw Error((await r.json()).error); }
      await refresh(); await onRefresh(); setRights({}); setMessage("Generated-shot status refreshed. Footage still needs human review; nothing was published.");
    } catch (e) { setError(e instanceof Error ? e.message : "Status unavailable. Refresh before taking another action."); }
    finally { setBusy(false); }
  }
  const editable = !!data?.canEdit && !busy && !dirty;
  const scene = board?.document.shots.find(s => s.id === shotId);
  const takes = (data?.jobs ?? []).filter(j => j.itemId === board?.itemId && j.shotId === shotId && j.status === "READY" && j.output && ["READY", "APPROVED", "REJECTED"].includes(j.output.status) && j.creativeBrief.revisions.length < 4 && (!scene?.clip || scene.clip.id === j.output.id));
  const parent = takes.find(j => j.id === revisionOfId);
  const canQuote = editable && data?.integrationAvailable && board?.status === "APPROVED" && scene && !scene.asset && (revisionOfId ? !!parent && feedback.trim().length >= 10 : !scene.clip);
  return <section className="panel" aria-label="Generated shot production" aria-busy={busy}>
    <h2>Generate supporting footage</h2>
    <p>Start from an approved, saved scene—not a free-form prompt. Quotes show a credit ceiling. Credits remain held through supplier processing and private normalization; only usable footage settles the charge. Review rights, likeness, accuracy and continuity before using the result.</p>
    {!data?.integrationAvailable && <p>Generated video is awaiting a verified provider integration. No generation can be purchased here yet. Uploaded footage and local motion cards remain separate.</p>}
    <p id="shot-generation-help">Save edits and approve the whole storyboard first. Start with an empty scene, or request a new take of completed generated footage. No reference image or previous video is sent to the model: this is feedback-guided regeneration, not a pixel-preserving edit. Nothing replaces your selected scene automatically.</p>
    <form onSubmit={e => { e.preventDefault(); if (canQuote) void act({ action: "quote", storyboardId: board?.id, shotId, ...(revisionOfId ? { revisionOfId, feedback } : { direction }) }); }}>
      <label>Approved scene for generation<select value={shotId} onChange={e => { setShotId(e.target.value); setRevisionOfId(""); setFeedback(""); }} disabled={!editable || board?.status !== "APPROVED"} aria-describedby="shot-generation-help"><option value="">Choose a scene</option>{board?.document.shots.filter(s => !s.asset).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
      <label>Generation approach<select value={revisionOfId} disabled={!editable || !shotId} onChange={e => { setRevisionOfId(e.target.value); setFeedback(""); }} aria-describedby="shot-take-help"><option value="">New direction · empty scenes only</option>{takes.map(j => <option key={j.id} value={j.id}>New take of {j.shotLabel} · take {j.creativeBrief.revisions.length + 1} · {j.id.slice(-6)}</option>)}</select></label>
      <p id="shot-take-help">A new take is a separately charged generation with its own quote and review. Each authorized replacement uses one of the creative’s three shared AI revision requests, including replacements without a parent take. Existing footage, approvals and renders remain untouched. New takes use ordinary production credits; revision-request limits are separate from credit balances.</p>
      {parent ? <>
        <p>Retained direction: {parent.creativeBrief.direction || "Approved scene and brand brief."}</p>
        {parent.creativeBrief.revisions.length > 0 && <ol aria-label="Previous take feedback">{parent.creativeBrief.revisions.map(r => <li key={r.parentId}>{r.feedback}</li>)}</ol>}
        <label>Feedback for this take<textarea required minLength={10} maxLength={1000} value={feedback} disabled={!editable} aria-describedby="shot-feedback-help shot-generation-error" onChange={e => setFeedback(e.target.value)} /></label>
        <p id="shot-feedback-help">Describe what should change and what to keep: framing, lighting, movement or mood. At least 10 characters. New facts, claims and dates still need confirmed brand evidence.</p>
      </> : <><label>Visual direction (optional)<textarea maxLength={1000} value={direction} disabled={!editable || !shotId} aria-describedby="shot-direction-help shot-generation-error" onChange={e => setDirection(e.target.value)} /></label><p id="shot-direction-help">Describe lighting, framing, camera movement and mood for this business scene. This does not approve new facts, logos or product depictions.</p></>}
      {scene?.clip && !parent && <p>Select the completed take used by this scene, or save and approve an empty scene. Uploaded footage cannot be regenerated here.</p>}
      <button className="button" disabled={!canQuote}>{parent ? "Get new-take quote · no charge" : "Get shot quote · no charge"}</button>
    </form>
    <button type="button" className="button" disabled={busy || dirty} onClick={() => void act()}>Refresh generated-shot status</button>
    {dirty && <p>Save storyboard edits before requesting or authorizing footage.</p>}
    {!data?.canEdit && <p>Workspace editing access is required to authorize or cancel generation.</p>}
    <p id="shot-generation-error" ref={problem} tabIndex={-1} role="alert" className="form-error">{error}</p><p ref={notice} tabIndex={-1} role="status">{message}</p>
    {data?.jobs.length === 0 && <p>No generated-shot jobs yet.</p>}
    {data?.jobs.map(job => <article className="review-card" key={job.id} aria-label={`Generation ${job.shotLabel}`}>
      <h3>{job.shotLabel} · {(job.durationMs / 1000).toFixed(2)} seconds</h3>
      <p>Take {job.creativeBrief.revisions.length + 1} · reference {job.id.slice(-6)}. New jobs carry this reference in the footage library.</p>
      <p>{status[job.status] ?? "Status requires operator review"} · quote ceiling {job.credits} credits</p>
      <details><summary>Creative direction{job.revisionOfId ? ` · revision ${job.creativeBrief.revisions.length}` : " · initial take"}</summary><p>{job.creativeBrief.direction || "Approved scene and brand brief."}</p>{job.creativeBrief.revisions.length > 0 && <ol>{job.creativeBrief.revisions.map(r => <li key={r.parentId}>{r.feedback}</li>)}</ol>}</details>
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
