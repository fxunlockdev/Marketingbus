"use client";
import { useEffect, useRef, useState } from "react";
import { DEFAULT_CLIP_EDIT, clipRangeFits, type VideoShot } from "@/lib/video/document";
import type { StudioClip } from "./clip-library";
import { videoLayout, type VideoFormat } from "@/lib/video/layout";

export function ClipShotEditor({ businessId, shot, clip, background, format, onChange }: { businessId: string; shot: VideoShot; clip?: StudioClip; background: string; format?: VideoFormat; onChange: (edit: NonNullable<VideoShot["clipEdit"]>) => void }) {
  const media = videoLayout({ format }).media;
  const edit = shot.clipEdit ?? DEFAULT_CLIP_EDIT, valid = !!clip?.usable && clipRangeFits(shot, clip.durationMs);
  const end = (edit.startMs + shot.durationMs) / 1000, start = edit.startMs / 1000;
  const [url, setUrl] = useState(""), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const video = useRef<HTMLVideoElement>(null), request = useRef<AbortController | null>(null);
  const previewKey = JSON.stringify({ businessId, clip: shot.clip, edit, format, duration: shot.durationMs, usable: clip?.usable });
  useEffect(() => { request.current?.abort(); setUrl(""); setError(""); setLoading(false); return () => request.current?.abort(); }, [previewKey]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const update = (change: Partial<typeof edit>) => onChange({ ...edit, ...change });
  const help = `clip-edit-${shot.id}`, rangeError = `clip-range-${shot.id}`;
  async function preview() {
    if (!shot.clip || !valid) return;
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    setLoading(true); setError("");
    try {
      const r = await fetch(`/api/businesses/${businessId}/clips/${shot.clip.id}`, { signal: abort.signal });
      if (!r.ok) throw Error((await r.json()).error);
      const bytes = await r.blob(); if (!abort.signal.aborted) setUrl(URL.createObjectURL(bytes));
    } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Preview unavailable."); }
    finally { if (!abort.signal.aborted) setLoading(false); }
  }
  return <div aria-busy={loading}>
    <p id={help}>Select the source start time; the scene duration sets its end. Fit keeps the whole frame. Fill crops the frame—check that products, people and visible claims remain accurate. Crop position only applies to Fill.</p>
    {clip?.processorVersion === "silent-clip-v1" && <p>This earlier clip contains baked-in letterboxing. It is preserved as reviewed. Upload the original again if you need framing without that padding.</p>}
    <div className="composition-controls">
      <label>Footage start (seconds)<input required type="number" min={0} max={7} step={0.25} value={start} aria-describedby={`${help} ${rangeError}`} aria-invalid={!valid} onChange={e => update({ startMs: Math.round(Number(e.target.value) * 1000) })} /></label>
      <label>Footage framing<select value={edit.fit} aria-describedby={help} onChange={e => update({ fit: e.target.value as "contain" | "cover" })}><option value="contain">Fit · keep the whole frame</option><option value="cover">Fill · crop to scene</option></select></label>
      <label>Horizontal crop position<input type="range" min={0} max={100} step={5} value={edit.x} disabled={edit.fit !== "cover"} aria-valuetext={`${edit.x}% from left`} aria-describedby={help} onChange={e => update({ x: Number(e.target.value) })} /></label>
      <label>Vertical crop position<input type="range" min={0} max={100} step={5} value={edit.y} disabled={edit.fit !== "cover"} aria-valuetext={`${edit.y}% from top`} aria-describedby={help} onChange={e => update({ y: Number(e.target.value) })} /></label>
    </div>
    <p id={rangeError} role={valid ? undefined : "alert"} className={valid ? undefined : "form-error"}>{valid ? `Selected source: ${start.toFixed(2)}–${end.toFixed(2)}s of ${(clip!.durationMs / 1000).toFixed(2)}s.` : "This source range is unavailable or exceeds the approved footage. Adjust the start/duration or choose another clip."}</p>
    <button type="button" className="button" disabled={loading || !valid} onClick={() => void preview()}>Preview draft footage · {shot.label}</button>
    <p role="alert" className="form-error">{error}</p>
    {url && <>
      <p>Draft footage preview only—not a saved render or approval. Browser cropping is an approximation; inspect the final encoded reel before approving it. Audio is absent.</p>
      <div style={{ width: "100%", maxWidth: 304, aspectRatio: `${media.width} / ${media.height}`, background }}>
        <video ref={video} controls playsInline preload="metadata" src={url} aria-label={`Draft footage for ${shot.label}`} style={{ width: "100%", height: "100%", objectFit: edit.fit, objectPosition: edit.fit === "cover" ? `${edit.x}% ${edit.y}%` : "50% 50%" }}
          onLoadedMetadata={e => { e.currentTarget.currentTime = start; }}
          onPlay={e => { if (e.currentTarget.currentTime < start || e.currentTarget.currentTime >= end) e.currentTarget.currentTime = start; }}
          onTimeUpdate={e => { if (e.currentTarget.currentTime >= end) { e.currentTarget.pause(); if (e.currentTarget.currentTime > end + 0.05) e.currentTarget.currentTime = end; } }}
          onSeeking={e => { if (e.currentTarget.currentTime < start) e.currentTarget.currentTime = start; else if (e.currentTarget.currentTime > end) e.currentTarget.currentTime = end; }} />
      </div>
      <button type="button" className="button" onClick={() => { const v = video.current; if (v) { v.currentTime = start; void v.play().catch(() => setError("Use the video playback control to start the preview.")); } }}>Play selected range · {shot.label}</button>
    </>}
  </div>;
}
