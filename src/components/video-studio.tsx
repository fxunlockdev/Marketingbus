"use client";
import { useEffect, useState } from "react";
import { MOTION_RENDERER_VERSION } from "@/lib/video/version";
import { storyboardDocument, subtitleVtt, totalDuration, type StoryboardDocument } from "@/lib/video/document";
type Board = { id: string; itemId: string; version: number; status: string; document: StoryboardDocument; shotApprovals: { shotId: string }[] };
type Render = { id: string; storyboardId: string; rendererVersion: string; status: string; durationMs: number; errorCode: string | null };
type Asset = { id: string; sha256: string; label: string; purpose: string; generated: boolean };
export function VideoStudio({ businessId, items }: { businessId: string; items: { id: string; title: string }[] }) {
  const [boards, setBoards] = useState<Board[]>([]), [renders, setRenders] = useState<Render[]>([]), [assets, setAssets] = useState<Asset[]>([]), [canEdit, setCanEdit] = useState(false), [itemId, setItemId] = useState(""), [boardId, setBoardId] = useState(""), [document, setDocument] = useState<StoryboardDocument | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState(""), [preview, setPreview] = useState(""), [captions, setCaptions] = useState(""), [watched, setWatched] = useState(false), [confirmRemove, setConfirmRemove] = useState(false);
  const endpoint = `/api/businesses/${businessId}/video`, history = boards.filter(b => b.itemId === itemId), board = history.find(b => b.id === boardId) ?? history[0], render = renders.find(r => r.storyboardId === board?.id), dirty = !!document && JSON.stringify(document) !== JSON.stringify(board?.document), readonly = busy || !canEdit || board?.status === "SUPERSEDED";
  async function refresh(signal?: AbortSignal) {
    const response = await fetch(endpoint, { signal }), data = await response.json(); if (!response.ok) throw Error(data.error);
    if (!signal?.aborted) { setBoards(data.storyboards); setRenders(data.renders); setAssets(data.assets); setCanEdit(data.canEdit); }
  }
  useEffect(() => { const abort = new AbortController(); void refresh(abort.signal).catch(e => { if (!abort.signal.aborted) setError(e.message); }); return () => abort.abort(); }, [businessId]);
  useEffect(() => { setDocument(board?.document ?? null); setPreview(""); setCaptions(""); setWatched(false); setConfirmRemove(false); }, [board]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); if (captions) URL.revokeObjectURL(captions); }, [preview, captions]);
  async function act(body?: unknown) {
    setBusy(true); setError(""); setMessage("");
    try {
      if (body) { const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), data = await response.json(); if (!response.ok) throw Error(data.error); if (data.storyboardId) setBoardId(data.storyboardId); }
      await refresh(); setMessage("Video workflow updated. No model call or automatic publication.");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to update video."); }
    finally { setBusy(false); }
  }
  async function media(format: "mp4" | "vtt" | "json", download: boolean) {
    if (!render || !board) return; setBusy(true); setError("");
    try {
      const response = await fetch(`${endpoint}/${render.id}?format=${format}&download=${download}`);
      if (!response.ok) throw Error((await response.json()).error);
      const url = URL.createObjectURL(await response.blob());
      if (!download) { setPreview(url); setCaptions(URL.createObjectURL(new Blob([subtitleVtt(board.document)], { type: "text/vtt" }))); setWatched(false); }
      else { const a = window.document.createElement("a"); a.href = url; a.download = `motion-reel.${format}`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch (e) { setError(e instanceof Error ? e.message : "Video unavailable."); }
    finally { setBusy(false); }
  }
  function changeShot(index: number, change: Partial<StoryboardDocument["shots"][number]>) { if (document) setDocument({ ...document, shots: document.shots.map((s, i) => i === index ? { ...s, ...change } : s) }); }
  function move(index: number, step: number) { if (!document) return; const shots = [...document.shots]; [shots[index], shots[index + step]] = [shots[index + step], shots[index]]; setDocument({ ...document, shots }); }
  return <div className="production-list" aria-busy={busy}>
    <p role="alert" className="form-error">{error}</p><p role="status">{message}</p>
    <section className="panel"><h2>Plan a motion reel</h2><p>Build a silent, captioned 720 × 1280 reel using approved originals or approved generated artwork and finite hold/fade scenes. Up to six shots and 30 seconds. Model-generated footage, voiceover and music are not enabled in this workflow.</p>
      <p id="video-artwork-help">Reusing artwork makes no new model call. Generated artwork remains linked to its approved source copy and references; changes or revoked permissions block rendering and downloads. Logos must remain original assets. Review every scene for factual and brand fidelity.</p>
      <label htmlFor="video-item">Planned creative</label><select id="video-item" value={itemId} disabled={busy} onChange={e => { setItemId(e.target.value); setBoardId(""); }}><option value="">Choose a planned creative</option>{items.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
      <p>Confirm your brand and approve any existing copy first. Storyboarding and this bounded local renderer do not spend AI credits.</p>
      <div className="tag-row"><button className="button dark" disabled={busy || !canEdit || !itemId} onClick={() => act({ action: "create", itemId })}>Create or open storyboard</button><button className="button" disabled={busy} onClick={() => act()}>Refresh video status</button></div>
      {!canEdit && <p>Workspace editing access is required to change or approve a storyboard.</p>}
      {history.length > 1 && <><label htmlFor="video-version">Storyboard history</label><select id="video-version" value={board?.id} onChange={e => setBoardId(e.target.value)}>{history.map(b => <option key={b.id} value={b.id}>Version {b.version} · {b.status.toLowerCase()}</option>)}</select></>}
    </section>
    {board && document && <>
      <section className="panel"><h2>Storyboard version {board.version} · {board.status.toLowerCase()}</h2><p>{totalDuration(document) / 1000} seconds · {document.shots.length} shots. Saving a change creates a new version; unchanged shot approvals are retained. Final storyboard and rendered-video approvals are separate.</p>
        <form onSubmit={e => { e.preventDefault(); const parsed = storyboardDocument.safeParse(document); if (!parsed.success) { setError(parsed.error.issues[0].message); return; } void act({ action: "save", storyboardId: board.id, document: parsed.data }); }}>
          <fieldset disabled={readonly}><legend>Reel settings</legend><label>Title<input required maxLength={100} value={document.title} onChange={e => setDocument({ ...document, title: e.target.value })} /></label><label>Background colour<input type="color" value={document.background} onChange={e => setDocument({ ...document, background: e.target.value })} /></label>
            <label>Original logo<select value={document.logo?.id || ""} onChange={e => { const a = assets.find(a => a.id === e.target.value); setDocument({ ...document, logo: a ? { id: a.id, sha256: a.sha256 } : null }); }}><option value="">No logo</option>{assets.filter(a => a.purpose === "logo").map(a => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label>
          </fieldset>
          {document.shots.map((shot, index) => <fieldset key={shot.id} disabled={readonly}><legend>Shot {index + 1} · {shot.label}</legend>
            <label>Shot name<input required maxLength={80} value={shot.label} onChange={e => changeShot(index, { label: e.target.value })} /></label>
            <label>On-screen caption<textarea required maxLength={120} value={shot.caption} onChange={e => changeShot(index, { caption: e.target.value })} /></label>
            <div className="composition-controls"><label>Duration (seconds)<input type="number" required min={1} max={8} step={0.25} value={shot.durationMs / 1000} onChange={e => changeShot(index, { durationMs: Math.round(Number(e.target.value) * 1000) })} /></label>
              <label>Motion<select value={shot.motion} onChange={e => changeShot(index, { motion: e.target.value as "hold" | "fade" })}><option value="hold">Hold · no motion</option><option value="fade">Fade in and out</option></select></label>
              <label>Scene image<select aria-describedby="video-artwork-help" value={shot.asset?.id || ""} onChange={e => { const a = assets.find(a => a.id === e.target.value); changeShot(index, { asset: a ? { id: a.id, sha256: a.sha256 } : null }); }}><option value="">Caption-only scene</option>{shot.asset && !assets.some(a => a.id === shot.asset!.id) && <option value={shot.asset.id} disabled>Unavailable image · choose a replacement</option>}<optgroup label="Approved originals">{assets.filter(a => !a.generated).map(a => <option key={a.id} value={a.id}>{a.label}</option>)}</optgroup><optgroup label="Approved generated artwork">{assets.filter(a => a.generated).map(a => <option key={a.id} value={a.id}>{a.label} · generated</option>)}</optgroup></select></label></div>
            <p>Saved review: {board.shotApprovals.some(a => a.shotId === shot.id) ? "approved" : "needs review"}{dirty ? ". Unsaved edits are not approved." : "."}</p>
            <div className="tag-row"><button type="button" className="button" disabled={dirty} onClick={() => act({ action: "review-shot", storyboardId: board.id, shotId: shot.id, approved: true })}>Approve saved shot {index + 1}</button><button type="button" className="button" disabled={dirty} onClick={() => act({ action: "review-shot", storyboardId: board.id, shotId: shot.id, approved: false })}>Request changes to shot {index + 1}</button></div>
            <div className="tag-row"><button type="button" className="button" disabled={index === 0} onClick={() => move(index, -1)}>Move shot {index + 1} earlier</button><button type="button" className="button" disabled={index === document.shots.length - 1} onClick={() => move(index, 1)}>Move shot {index + 1} later</button><button type="button" className="button" disabled={document.shots.length === 1} onClick={() => setDocument({ ...document, shots: document.shots.filter(s => s.id !== shot.id) })}>Remove shot {index + 1}</button></div>
          </fieldset>)}
          <div className="tag-row"><button type="button" className="button" disabled={readonly || document.shots.length >= 6} onClick={() => setDocument({ ...document, shots: [...document.shots, { id: crypto.randomUUID(), label: "New scene", caption: "Learn more", durationMs: 3000, motion: "hold", asset: null }] })}>Add shot</button><button className="button dark" disabled={readonly}>Save storyboard version</button></div>
        </form>
        {dirty && <p role="status">Save changes before reviewing or rendering. Only the saved version is used.</p>}
        <button className="button" disabled={readonly || dirty} onClick={() => act({ action: "approve-storyboard", storyboardId: board.id })}>Approve complete storyboard</button>
      </section>
      <section className="panel"><h2>Render and final review</h2><p>Renders are queued on a bounded local worker. Server limits apply; no paid AI provider is called. Watch the complete video for continuity, caption fit, reading time and brand fidelity before approval.</p>
        <button className="button dark" disabled={readonly || dirty || board.status !== "APPROVED"} onClick={() => act({ action: "render", storyboardId: board.id })}>Render approved storyboard</button>
        {board.status !== "APPROVED" && <p>Approve every saved shot and the complete storyboard to enable rendering.</p>}
        {render && <><p role="status">Render: {render.status.replaceAll("_", " ").toLowerCase()}</p>
          {render.rendererVersion !== MOTION_RENDERER_VERSION && <p role="status">This video uses an older renderer. Render the approved storyboard again and review the new caption layout before approval or download. The original stored file is retained until its scheduled cleanup.</p>}
          {render.status === "QUEUED" && <button className="button" disabled={busy || !canEdit} onClick={() => act({ action: "cancel-render", renderId: render.id })}>Cancel queued render</button>}
          {["RUNNING", "STORING"].includes(render.status) && <p>Rendering or storage is in progress. Refresh to check completion; you can remove the output once it settles.</p>}
          {render.status === "FAILED" && <><p>No verified video is available. Check whether storage completed, or save a new storyboard version to explicitly request another render.</p><button className="button" disabled={readonly} onClick={() => act({ action: "recover-render", renderId: render.id })}>Check stored video · no rerender</button></>}
          {render.rendererVersion === MOTION_RENDERER_VERSION && ["READY", "APPROVED", "REJECTED"].includes(render.status) && <><button className="button" disabled={busy || dirty} onClick={() => media("mp4", false)}>Preview saved video</button>
            {preview && <video controls playsInline preload="metadata" src={preview} aria-label="Saved silent motion reel for final review" style={{ maxWidth: "100%", maxHeight: 650 }}><track kind="captions" src={captions} srcLang="en" label="On-screen captions" default /></video>}
            <label className="checkbox-label"><input type="checkbox" checked={watched} onChange={e => setWatched(e.target.checked)} /> I watched the complete saved video and reviewed continuity, captions and brand fidelity.</label>
            <div className="tag-row"><button className="button" disabled={readonly || dirty || !preview || !watched} onClick={() => act({ action: "approve-render", renderId: render.id, continuityReviewed: true })}>Approve finished video</button><button className="button" disabled={readonly || dirty} onClick={() => act({ action: "reject-render", renderId: render.id })}>Reject finished video</button></div>
            <div className="tag-row">{(["mp4", "vtt", "json"] as const).map(format => <button className="button" key={format} disabled={busy || dirty || render.status !== "APPROVED"} onClick={() => media(format, true)}>Download {format.toUpperCase()}</button>)}</div>
          </>}
          {["READY", "APPROVED", "REJECTED", "FAILED"].includes(render.status) && (confirmRemove ? <><p>Remove this private video? Access is revoked immediately and physical deletion is queued after seven days.</p><button className="button" disabled={busy || !canEdit} onClick={() => act({ action: "archive-render", renderId: render.id })}>Confirm video removal</button><button className="button" onClick={() => setConfirmRemove(false)}>Keep video</button></> : <button className="button" disabled={busy || !canEdit} onClick={() => setConfirmRemove(true)}>Remove saved video</button>)}
        </>}
      </section>
    </>}
  </div>;
}
