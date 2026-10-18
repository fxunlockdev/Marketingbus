"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { ReviewMediaItem } from "@/lib/production/review";
import { STATIC_RENDERER_VERSION } from "@/lib/composition/version";
import type { AssetTarget } from "./asset-studio";

type Kind = "image" | "composition" | "video";
export function ReviewMediaCard({ businessId, row, canEdit, copyApproved, onOpen, onChange }: {
  businessId: string; row: ReviewMediaItem; canEdit: boolean; copyApproved: boolean;
  onOpen: (target: AssetTarget) => void; onChange: (message: string) => void;
}) {
  const uid = useId(), outcome = useRef<HTMLParagraphElement>(null), controller = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState<{ kind: Kind; url: string; captions?: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [reviewed, setReviewed] = useState(false);
  const endpoint = `/api/businesses/${businessId}`;
  const alreadyApproved = (kind: Kind) => kind === "image" ? row.image?.status === "APPROVED" : kind === "composition" ? row.composition?.approved : row.video?.render?.status === "APPROVED";
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (error) outcome.current?.focus(); }, [error]);
  useEffect(() => () => { if (preview) { URL.revokeObjectURL(preview.url); if (preview.captions) URL.revokeObjectURL(preview.captions); } }, [preview]);
  async function show(kind: Kind) {
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(""); setPreview(null); setReviewed(false);
    const path = kind === "image" ? `/images/${row.image!.id}` : kind === "composition" ? `/compositions?export=${encodeURIComponent(row.composition!.id)}&placement=square&format=png&preview=true` : `/video/${row.video!.render!.id}?format=mp4&download=false`;
    try {
      const response = await fetch(endpoint + path, { signal: abort.signal });
      if (!response.ok) throw Error((await response.json()).error);
      const blob = await response.blob();
      if (!abort.signal.aborted) setPreview({ kind, url: URL.createObjectURL(blob), ...(kind === "video" && row.video?.captions ? { captions: URL.createObjectURL(new Blob([row.video.captions], { type: "text/vtt" })) } : {}) });
    } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Saved media is unavailable. Refresh and review the current version."); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  async function act(kind: Kind, approve: boolean) {
    if (!canEdit || busy || approve && (!reviewed || preview?.kind !== kind || alreadyApproved(kind))) return;
    setBusy(true); setError("");
    const path = kind === "image" ? "images" : kind === "composition" ? "compositions" : "video";
    const body = kind === "image" ? { action: approve ? "approve" : "reject", generationId: row.image!.id, ...(approve ? { fidelityReviewed: true } : {}) }
      : kind === "composition" ? { action: "approve", rendererVersion: STATIC_RENDERER_VERSION, itemId: row.itemId, version: row.composition!.version }
      : { action: approve ? "approve-render" : "reject-render", renderId: row.video!.render!.id, ...(approve ? { continuityReviewed: true } : {}) };
    try {
      const response = await fetch(`${endpoint}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json(); if (!response.ok) throw Error(data.error);
      const notice = approve ? "This exact saved version was approved. Nothing was published." : "Saved version rejected. No regeneration or credit charge.";
      // The inbox owns success focus because this card is replaced on refresh.
      setPreview(null); setReviewed(false); onChange(notice);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save review."); }
    finally { setBusy(false); }
  }
  const labels = { image: "artwork", composition: "layout", video: "video" };
  return <section className="panel review-media" aria-labelledby={`${uid}-title`} aria-busy={busy}>
    <h3 id={`${uid}-title`}>Saved images & video</h3>
    <p ref={outcome} tabIndex={-1} role="alert" className="error">{error}</p>
    {!row.image && !row.composition && !row.video && <p>No media has been made for this creative yet. The copy preview above is not a finished image.</p>}
    <div className="review-media-status">
      {row.image && <p>Artwork v{row.image.version} · {row.image.current ? row.image.status.toLowerCase().replaceAll("_", " ") : "source changed — review in Asset studio"}</p>}
      {row.composition && <p>Layout v{row.composition.version} · {row.composition.current ? row.composition.approved ? "approval recorded — preview rechecks assets" : "needs visual review" : "source changed — create a current layout"}</p>}
      {row.video && <p>Storyboard v{row.video.version} · {row.video.current ? row.video.status.toLowerCase() : "source changed"}{row.video.format ? ` · ${row.video.format}` : ""}{row.video.render ? ` · video ${row.video.render.status.toLowerCase().replaceAll("_", " ")} (${row.video.render.durationMs / 1000}s)` : " · not rendered"}</p>}
    </div>
    <div className="tag-row">
      {row.image?.previewable && <button className="button secondary" disabled={busy} onClick={() => show("image")}>Preview saved artwork</button>}
      {row.composition?.previewable && <button className="button secondary" disabled={busy} onClick={() => show("composition")}>Preview saved layout</button>}
      {row.video?.render?.previewable && <button className="button secondary" disabled={busy} onClick={() => show("video")}>Preview saved video</button>}
    </div>
    {preview && <div className="review-media-preview">
      {preview.kind === "video" ? <video controls playsInline preload="metadata" src={preview.url} aria-label="Saved video for platform review"><track kind="captions" src={preview.captions} srcLang="en" label="On-screen captions" default /></video> : <img src={preview.url} alt={preview.kind === "image" ? "Actual saved generated supporting artwork" : "Saved composition rendered as a square for visual review"} />}
      <p>{preview.kind === "composition" ? "Square preview of the saved layout. Check other output sizes in Asset studio before publishing." : preview.kind === "image" ? "Supporting artwork only, before original logos, products and layout are composed." : "Watch the entire saved export. This is not a simulation of a platform's playback or safe areas."}</p>
      {canEdit && <>
        <label className="checkbox-label"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />{preview.kind === "video" ? `I watched the complete video and checked continuity, captions and brand fidelity.${row.video?.hasMusic ? " I listened to the full instrumental soundtrack and checked levels and absence of vocals." : ""}` : "I inspected this saved image for factual accuracy, brand fidelity, readable text and visual defects."}</label>
        {preview.kind === "composition" && !copyApproved && <p>Approve the exact copy before approving this layout.</p>}
        <div className="tag-row"><button className="button dark" disabled={busy || !reviewed || alreadyApproved(preview.kind) || preview.kind === "composition" && !copyApproved} onClick={() => act(preview.kind, true)}>Approve saved {labels[preview.kind]}</button>
          {preview.kind !== "composition" && <button className="button secondary" disabled={busy} onClick={() => act(preview.kind, false)}>Reject saved {labels[preview.kind]} · no regeneration</button>}
        </div>
      </>}
    </div>}
    {canEdit && <div className="tag-row"><button type="button" className="text-button" disabled={busy} onClick={() => onOpen({ itemId: row.itemId, mode: "images" })}>Edit images & design</button><button type="button" className="text-button" disabled={busy} onClick={() => onOpen({ itemId: row.itemId, mode: "video" })}>Edit video & motion</button></div>}
    <p className="small muted">Copy, supporting artwork, layout and final video have separate approvals. Every preview and approval rechecks access and source versions. Approval never posts automatically.</p>
  </section>;
}
