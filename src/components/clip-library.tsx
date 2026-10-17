"use client";
import { useEffect, useRef, useState } from "react";
export type StudioClip = { id: string; label: string; status: string; sha256: string; durationMs: number; purgeAfter: string };
export function ClipLibrary({ businessId, clips, canEdit, onChange }: { businessId: string; clips: StudioClip[]; canEdit: boolean; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState(""), [label, setLabel] = useState(""), [rights, setRights] = useState(false), [preview, setPreview] = useState<{ id: string; url: string } | null>(null), [watched, setWatched] = useState(false), [removeId, setRemoveId] = useState("");
  const file = useRef<HTMLInputElement>(null), endpoint = `/api/businesses/${businessId}/clips`;
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  useEffect(() => { setPreview(null); setWatched(false); }, [businessId]);
  async function act(id: string, action: string) {
    setBusy(true); setError(""); setMessage("");
    try {
      const r = await fetch(`${endpoint}/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...(action === "approve" ? { watched } : {}) }) }), data = await r.json();
      if (!r.ok) throw Error(data.error); setPreview(null); setWatched(false); setRemoveId(""); await onChange(); setMessage("Clip status updated. No generation or publication was requested.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not update this clip."); } finally { setBusy(false); }
  }
  async function show(id: string) {
    setBusy(true); setError(""); setPreview(null); setWatched(false);
    try { const r = await fetch(`${endpoint}/${id}`); if (!r.ok) throw Error((await r.json()).error); setPreview({ id, url: URL.createObjectURL(await r.blob()) }); }
    catch (e) { setError(e instanceof Error ? e.message : "Preview unavailable."); } finally { setBusy(false); }
  }
  return <section className="panel" aria-labelledby="clips-heading" aria-busy={busy}>
    <h2 id="clips-heading">Private footage library</h2>
    <p id="clip-help">Upload licensed H.264 MP4 footage: 1–8 seconds, up to 1080p and 20 MB. Audio is removed, not transcribed. Reviewed clips can be placed in a scene alongside motion cards. No paid AI calls. Processing requires the configured video worker.</p>
    <p>Originals are quarantined and cannot be previewed. Processed footage needs human review. Up to five clips are retained; originals and processed copies expire after 30 days. Removal blocks use immediately and deletes both copies after seven days. Downloaded copies and backups are separate.</p>
    <p role="alert" id="clip-error" className="form-error">{error}</p><p role="status">{message}</p>
    <form onSubmit={async e => {
      e.preventDefault(); const selected = file.current?.files?.[0]; if (!selected) return;
      setBusy(true); setError(""); setMessage("");
      try {
        if (selected.size > 20 * 1024 * 1024) throw Error("Clips must be no larger than 20 MB.");
        const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "video/mp4", "X-Clip-Label": encodeURIComponent(label), "X-Clip-Rights": rights ? "confirmed" : "" }, body: selected }), data = await r.json();
        if (!r.ok) throw Error(data.error); await onChange(); if (file.current) file.current.value = ""; setLabel(""); setRights(false); setMessage("Private clip uploaded. Refresh video status after processing, then preview and review it.");
      } catch (e) { setError(e instanceof Error ? e.message : "Upload failed."); } finally { setBusy(false); }
    }}>
      <fieldset disabled={busy || !canEdit}><legend>Upload footage</legend>
        <label>Clip name<input required maxLength={80} value={label} onChange={e => setLabel(e.target.value)} aria-describedby="clip-help clip-error" /></label>
        <label>MP4 file<input type="file" accept="video/mp4,.mp4" required ref={file} aria-describedby="clip-help clip-error" /></label>
        <label className="checkbox-label"><input type="checkbox" required checked={rights} onChange={e => setRights(e.target.checked)} /> I have permission to use this footage for this business, including people and products shown.</label>
        <button className="button" disabled={!rights}>Upload private clip</button>
      </fieldset>
    </form>
    {!canEdit && <p>Workspace editing access is required to upload or review footage.</p>}
    {!clips.length && <p>No clips uploaded yet.</p>}
    {clips.map(c => <article key={c.id} aria-label={`Clip ${c.label}`}>
      <h3>{c.label}</h3><p>{c.status.toLowerCase()} {c.durationMs ? `· ${(c.durationMs / 1000).toFixed(2)} seconds · silent` : ""}</p>
      {["READY", "APPROVED", "REJECTED"].includes(c.status) && <>
        <button className="button" disabled={busy} onClick={() => show(c.id)}>Preview {c.label}</button>
        {preview?.id === c.id && <><video controls playsInline preload="metadata" src={preview.url} aria-label={`Silent clip ${c.label}`} style={{ maxWidth: "100%", maxHeight: 450 }} /><p>Silent footage. Review visible claims and any source text; there is no speech track.</p>
          <label className="checkbox-label"><input type="checkbox" checked={watched} onChange={e => setWatched(e.target.checked)} /> I watched this entire clip and reviewed rights, accuracy and brand fidelity.</label></>}
        <div className="tag-row"><button className="button" disabled={busy || !canEdit || preview?.id !== c.id || !watched} onClick={() => act(c.id, "approve")}>Approve {c.label}</button><button className="button" disabled={busy || !canEdit} onClick={() => act(c.id, "reject")}>Reject {c.label}</button></div>
      </>}
      {c.status === "FAILED" && <><p>Processing or storage was not verified. Nothing can be used. Check for already-processed output without another upload or processing attempt.</p><button className="button" disabled={busy || !canEdit} onClick={() => act(c.id, "recover")}>Check stored clip {c.label}</button></>}
      {["QUEUED", "READY", "APPROVED", "REJECTED", "FAILED"].includes(c.status) && (removeId === c.id ? <><p>Remove this footage and revoke dependent video delivery?</p><button className="button" disabled={busy || !canEdit} onClick={() => act(c.id, "remove")}>Confirm removal of {c.label}</button><button className="button" onClick={() => setRemoveId("")}>Keep {c.label}</button></> : <button className="button" disabled={busy || !canEdit} onClick={() => setRemoveId(c.id)}>Remove {c.label}</button>)}
    </article>)}
  </section>;
}
