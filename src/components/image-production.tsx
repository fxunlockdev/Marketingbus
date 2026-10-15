"use client";
import { useEffect, useState } from "react";
type ImageJob = { id: string; itemId: string; version: number; status: string; credits: number; feedback: string; errorCode: string | null; expiresAt: string; output: { id: string; status: string } | null };
export function ImageProduction({ businessId, items, onChange }: { businessId: string; items: { id: string; title: string; format: string; revisions: { status: string }[] }[]; onChange: () => void }) {
  const [jobs, setJobs] = useState<ImageJob[]>([]), [itemId, setItemId] = useState(""), [canEdit, setCanEdit] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState(""), [feedback, setFeedback] = useState(""), [reviewed, setReviewed] = useState(false), [preview, setPreview] = useState("");
  const [generationId, setGenerationId] = useState("");
  const endpoint = `/api/businesses/${businessId}/images`, history = jobs.filter(j => j.itemId === itemId), current = history.find(j => j.id === generationId) ?? history[0];
  async function refresh(signal?: AbortSignal) {
    const response = await fetch(endpoint, { signal }), data = await response.json();
    if (!response.ok) throw Error(data.error);
    if (!signal?.aborted) { setJobs(data.images); setCanEdit(data.canEdit); }
  }
  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [businessId]); // Refresh is explicit: no endless polling or hidden generation.
  useEffect(() => { setReviewed(false); setFeedback(""); setPreview(""); }, [current?.id, current?.status]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  async function act(body?: unknown) {
    setBusy(true); setError(""); setMessage("");
    try {
      if (body) {
        const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const result = await response.json(); if (!response.ok) throw Error(result.error);
        if (result.generationId) setGenerationId(result.generationId);
      }
      await refresh(); onChange(); setMessage("Image workflow refreshed. Nothing is automatically approved or published.");
    } catch (e) { setError(e instanceof Error ? e.message : "Image action failed."); }
    finally { setBusy(false); }
  }
  async function showPreview() {
    if (!current) return; setBusy(true); setError("");
    try {
      const response = await fetch(`${endpoint}/${current.id}`);
      if (!response.ok) throw Error((await response.json()).error);
      setPreview(URL.createObjectURL(await response.blob()));
    } catch (e) { setError(e instanceof Error ? e.message : "Preview unavailable."); }
    finally { setBusy(false); }
  }
  return <section className="panel" aria-busy={busy}>
    <h2>Generate supporting artwork</h2>
    <p>Start from approved copy and your confirmed brand. Up to two approved style references are used automatically. Original logos and product photos are placed separately, without AI redrawing.</p>
    <p role="alert" className="form-error">{error}</p><p role="status">{message}</p>
    <label htmlFor="artwork-item">Approved creative</label>
    <select id="artwork-item" value={itemId} onChange={e => { setItemId(e.target.value); setGenerationId(""); }} disabled={busy}>
      <option value="">Choose approved static copy</option>
      {items.filter(i => i.format === "static" && i.revisions[0]?.status === "APPROVED").map(i => <option key={i.id} value={i.id}>{i.title}</option>)}
    </select>
    <p>Approve copy in the Review inbox first. A quote does not spend credits; generation requires a separate authorization.</p>
    <div className="tag-row">
      <button className="button" disabled={busy || !canEdit || !itemId} onClick={() => act({ action: "quote", itemId })}>Get artwork quote</button>
      <button className="button" disabled={busy} onClick={() => act()}>Refresh image status</button>
    </div>
    {!canEdit && <p>Workspace editing access is required to generate or review artwork.</p>}
    {history.length > 1 && <><label htmlFor="artwork-history">Image version history</label><select id="artwork-history" value={current?.id || ""} onChange={e => setGenerationId(e.target.value)} disabled={busy}>{history.map(job => <option key={job.id} value={job.id}>Version {job.version} · {job.status.toLowerCase()}</option>)}</select><p>Old versions remain visible for audit. Only a version matching the current brand, copy and latest authorization can be reviewed or used.</p></>}
    {current && <div>
      <h3>Artwork version {current.version} · {current.status.replaceAll("_", " ").toLowerCase()}</h3>
      {current.feedback && <p>Requested change: {current.feedback}</p>}
      {current.status === "OFFERED" && <><p>Reserve up to {current.credits} credits. Quote expires {new Date(current.expiresAt).toLocaleString()}. Unused credits are released after verified usage.</p><button className="button dark" disabled={busy || !canEdit} onClick={() => act({ action: "accept", generationId: current.id })}>Authorize up to {current.credits} credits</button></>}
      {["OFFERED", "QUEUED", "RUNNING"].includes(current.status) && <button className="button" disabled={busy || !canEdit} onClick={() => act({ action: "cancel", generationId: current.id })}>Cancel before submission</button>}
      {["QUEUED", "RUNNING", "SUBMITTING"].includes(current.status) && <p>Production is processing this version. Refresh for its result; another call will not be submitted automatically.</p>}
      {current.status === "NEEDS_RECONCILIATION" && <p role="status">The provider outcome is uncertain. Credits remain held while an operator verifies the expense. Do not submit again.</p>}
      {current.status === "FAILED" && <p>No eligible image was delivered. Customer credits were released; an operator can inspect the failure.</p>}
      {["READY", "APPROVED", "REJECTED"].includes(current.status) && current.output?.status === "READY" && <>
        <button className="button" disabled={busy} onClick={showPreview}>Preview artwork for review</button>
        {preview && <img src={preview} alt="Generated supporting artwork awaiting brand and factual review" style={{ maxWidth: "100%", maxHeight: 600, objectFit: "contain" }} />}
        <p>Check relevance, unwanted text, invented claims, misleading product details and visual defects. This review does not certify rights or professional quality.</p>
        <label className="checkbox-label"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} /> I reviewed the actual image for brand suitability, factual risks and visual defects.</label>
        <div className="tag-row"><button className="button" disabled={busy || !canEdit || !reviewed || !preview} onClick={() => act({ action: "approve", generationId: current.id, fidelityReviewed: true })}>Approve artwork for composition</button><button className="button" disabled={busy || !canEdit} onClick={() => act({ action: "reject", generationId: current.id })}>Reject artwork · no regeneration</button></div>
        <label htmlFor="artwork-feedback">Specific revision request</label>
        <textarea id="artwork-feedback" value={feedback} maxLength={1000} onChange={e => setFeedback(e.target.value)} aria-describedby="artwork-revision-help" />
        <p id="artwork-revision-help">Describe what should change and what must stay. A revision creates a new quote, not an automatic charge. Earlier approved artwork is revoked only when the new quote is authorized.</p>
        <button className="button" disabled={busy || !canEdit || feedback.trim().length < 5} onClick={() => act({ action: "quote", itemId, parentId: current.id, feedback })}>Quote this revision</button>
        {current.status === "APPROVED" && <p>Next: use approved brand assets below to create a new layout containing this artwork, then review the complete composition.</p>}
      </>}
    </div>}
  </section>;
}
