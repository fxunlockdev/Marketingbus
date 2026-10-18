"use client";
import { useEffect, useRef, useState } from "react";
import type { StudioClip } from "./clip-library";
export function AudioLibrary({ businessId, tracks, canEdit, onChange }: { businessId: string; tracks: StudioClip[]; canEdit: boolean; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState(""), [label, setLabel] = useState(""), [rights, setRights] = useState(false), [instrumental, setInstrumental] = useState(false), [listened, setListened] = useState(false), [removeId, setRemoveId] = useState("");
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null), file = useRef<HTMLInputElement>(null);
  const endpoint = `/api/businesses/${businessId}/audio`;
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  useEffect(() => { setPreview(null); setListened(false); }, [businessId]);
  async function task(work: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "Audio could not be updated."); } finally { setBusy(false); }
  }
  function review(id: string, action: string) { return task(async () => {
    const r = await fetch(`${endpoint}/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...(action === "approve" ? { watched: listened } : {}) }) }), data = await r.json();
    if (!r.ok) throw Error(data.error); setPreview(null); setListened(false); setRemoveId(""); await onChange(); setMessage("Music status updated. No AI generation or publication requested.");
  }); }
  function show(id: string) { return task(async () => {
    setPreview(null); setListened(false); const r = await fetch(`${endpoint}/${id}`); if (!r.ok) throw Error((await r.json()).error);
    setPreview({ id, url: URL.createObjectURL(await r.blob()) });
  }); }
  function upload() { return task(async () => {
    const source = file.current?.files?.[0]; if (!source || !rights || !instrumental || !label.trim()) throw Error("Choose a track, name it and confirm both usage statements.");
    if (source.size > 8 * 1024 * 1024) throw Error("Choose a track no larger than 8 MB.");
    const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": source.name.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : "audio/wav", "X-Audio-Label": encodeURIComponent(label), "X-Audio-Rights": "confirmed", "X-Audio-Instrumental": "confirmed" }, body: source }), data = await r.json();
    if (!r.ok) throw Error(data.error); if (file.current) file.current.value = ""; setLabel(""); setRights(false); setInstrumental(false); await onChange(); setMessage("Music is private and queued for processing. Refresh, listen and approve before use.");
  }); }
  return <section className="panel" aria-busy={busy} aria-labelledby="music-library-title">
    <h2 id="music-library-title">Instrumental music library</h2>
    <p id="music-upload-help">Upload licensed WAV or MP3 music, 1–30 seconds and up to 8 MB. No speech or vocals in this lane; on-screen text is not a speech transcript. Audio and footage share five retained files and six uploads per business per day. Originals stay private; only processed audio can be reviewed. No AI credits are spent.</p>
    <p role="alert" id="music-error" className="form-error">{error}</p><p role="status">{message}</p>
    <form onSubmit={e => { e.preventDefault(); void upload(); }} aria-describedby="music-upload-help music-error">
      <fieldset disabled={busy || !canEdit}><legend>Add instrumental music</legend>
        <label>Music name<input required maxLength={80} value={label} onChange={e => setLabel(e.target.value)} /></label>
        <label>Music file<input ref={file} type="file" required accept=".wav,.mp3,audio/wav,audio/mpeg" aria-describedby="music-upload-help" /></label>
        <label className="checkbox-label"><input required type="checkbox" checked={rights} onChange={e => setRights(e.target.checked)} /> I hold the required rights to use this music in this business’s marketing and chosen publishing destinations.</label>
        <label className="checkbox-label"><input required type="checkbox" checked={instrumental} onChange={e => setInstrumental(e.target.checked)} /> This is instrumental music with no speech or vocals.</label>
        <button className="button" type="submit">Upload private music</button>
      </fieldset>
    </form>
    {!canEdit && <p>Editing access and a saved storyboard are required to change the music library.</p>}
    <button className="button" disabled={busy} onClick={() => task(onChange)}>Refresh music status</button>
    {tracks.length === 0 && <p>No music uploaded. Silent video remains available.</p>}
    {tracks.map(track => <article key={track.id} className="panel"><h3>{track.label}</h3><p>{track.status.toLowerCase()} · {track.durationMs / 1000}s · {track.usable ? "approved for this brand" : "not available for a storyboard"}</p>
      {["READY", "APPROVED", "REJECTED"].includes(track.status) && <>
        <button className="button" disabled={busy} onClick={() => show(track.id)}>Listen to {track.label}</button>
        {preview?.id === track.id && <><audio controls preload="metadata" src={preview.url} aria-label={`Review instrumental music: ${track.label}`} style={{ maxWidth: "100%" }} /><label className="checkbox-label"><input type="checkbox" checked={listened} onChange={e => setListened(e.target.checked)} /> I listened to the entire track and confirmed rights, no speech or vocals, and brand fit.</label></>}
        <div className="tag-row"><button className="button" disabled={busy || !canEdit || preview?.id !== track.id || !listened} onClick={() => review(track.id, "approve")}>Approve music {track.label}</button><button className="button" disabled={busy || !canEdit} onClick={() => review(track.id, "reject")}>Reject music {track.label}</button></div>
      </>}
      {track.status === "FAILED" && <><p>Processing was not verified. Check for already-processed bytes without another upload or decoding attempt.</p><button className="button" disabled={busy || !canEdit} onClick={() => review(track.id, "recover")}>Check stored music {track.label}</button></>}
      {["QUEUED", "READY", "APPROVED", "REJECTED", "FAILED"].includes(track.status) && (removeId === track.id ? <><p>Remove this track and revoke dependent video delivery? Private files will be deleted after seven days; existing downloads are separate.</p><button className="button" disabled={busy || !canEdit} onClick={() => review(track.id, "remove")}>Confirm music removal {track.label}</button><button className="button" onClick={() => setRemoveId("")}>Keep music {track.label}</button></> : <button className="button" disabled={busy || !canEdit} onClick={() => setRemoveId(track.id)}>Remove music {track.label}</button>)}
    </article>)}
  </section>;
}
