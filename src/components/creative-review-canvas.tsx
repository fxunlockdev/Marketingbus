"use client";
import { useState } from "react";
import { ProductionCard, type ProductionItemView } from "./production-card";
import { ReviewMediaCard } from "./review-media";
import type { ReviewMediaItem } from "@/lib/production/review";
import type { AssetTarget } from "./asset-studio";

export function CreativeReviewCanvas({ business, item, row, canEdit, busy, post, onOpen, onChange, onConnections }: {
  business: { id: string; name: string; color: string; designPreset: string };
  item: ProductionItemView; row?: ReviewMediaItem; canEdit: boolean; busy: boolean;
  post: (data: Record<string, unknown>) => Promise<unknown>;
  onOpen: (target: AssetTarget) => void; onChange: (message: string) => void; onConnections?: () => void;
}) {
  const [target, setTarget] = useState("copy"), [feedback, setFeedback] = useState("");
  const [working, setWorking] = useState(false), [error, setError] = useState("");
  const [offer, setOffer] = useState<{ id: string; credits: number } | null>(null);
  const revision = item.revisions[0], allowance = row?.revisionAllowance;
  const exhausted = allowance?.remaining === 0;
  const endpoint = `/api/businesses/${business.id}/images`;
  async function reviseImage(accept = false) {
    setWorking(true); setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(accept ? { action: "accept", generationId: offer!.id } : { action: "quote", itemId: item.id, parentId: row!.image!.id, feedback }) });
      const data = await response.json(); if (!response.ok) throw Error(data.error);
      if (accept) { setOffer(null); onChange("Image revision authorized. One of this creative’s three revision requests was used; nothing was approved or posted."); }
      else {
        const listed = await fetch(endpoint), jobs = await listed.json(); if (!listed.ok) throw Error(jobs.error);
        const job = jobs.images.find((j: { id: string }) => j.id === data.generationId);
        if (!job) throw Error("Quote unavailable. Refresh saved media.");
        setOffer({ id: job.id, credits: job.credits });
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to revise artwork."); }
    finally { setWorking(false); }
  }
  return <div className="creative-review-canvas">
    <header className="canvas-heading"><div><p className="eyebrow">CREATIVE REVIEW · {item.channel}</p><h2>{item.title}</h2></div><span className="tag">{item.status.toLowerCase().replaceAll("_", " ")}</span></header>
    <section className="canvas-feedback" aria-label={`Improve ${item.title}`} aria-busy={working}>
      <h3>Make it more yours.</h3>
      <p className="revision-meter" role="status">{allowance ? `${allowance.remaining} of 3 AI revisions remaining` : "Loading revision allowance…"}</p>
      <p className="small muted">Shared across copy, artwork and new video takes. A quote uses none; authorizing a revision uses one, even if later cancelled or unsuccessful. Manual edits and comments are unlimited. Credits are quoted separately.</p>
      {exhausted && <p className="notice">Revision limit reached. You can still edit manually, approve or reject this creative.</p>}
      <label htmlFor={`feedback-target-${item.id}`}>What should change?</label>
      <select id={`feedback-target-${item.id}`} value={target} disabled={working} onChange={e => { setTarget(e.target.value); setOffer(null); setError(""); }}>
        <option value="copy">Caption & creative concept</option><option value="image">Supporting artwork</option><option value="video">A video scene</option>
      </select>
      {target === "copy" && (revision ? <ProductionCard item={item} brand={business} busy={busy || !canEdit} post={post} review section="feedback" revisionsRemaining={allowance?.remaining} /> : <p>No copy version is ready yet. Create the concept in Asset studio.</p>)}
      {target === "image" && <>
        <p>Describe one focused change—such as warmer light or a quieter background—and what must stay. Original logos and products are edited separately, not redrawn.</p>
        {row?.image?.previewable ? <form onSubmit={e => { e.preventDefault(); void reviseImage(); }}>
          <label htmlFor={`image-feedback-${item.id}`}>Artwork feedback</label><textarea id={`image-feedback-${item.id}`} required minLength={5} maxLength={1000} value={feedback} aria-describedby={`image-error-${item.id}`} onChange={e => { setFeedback(e.target.value); setOffer(null); }} />
          <button className="button secondary" disabled={working || busy || !canEdit || exhausted}>Quote artwork revision</button>
          {offer && <div className="notice"><p>Up to {offer.credits} credits · uses one revision request. No generation has started.</p><button type="button" className="button dark" disabled={working || busy || !canEdit || exhausted} onClick={() => reviseImage(true)}>Authorize artwork revision</button></div>}
        </form> : <p>A current completed artwork and approved copy are required before requesting an image revision.</p>}
        <p id={`image-error-${item.id}`} role="alert" className="error">{error}</p>
      </>}
      {target === "video" && <><p>Select the exact scene and take in the video editor. Keep approved scenes unchanged; each authorized replacement uses one shared revision request.</p><button className="button secondary" disabled={!canEdit || working} onClick={() => onOpen({ itemId: item.id, mode: "video" })}>Choose scene to improve</button></>}
    </section>
    <section className="canvas-preview" aria-label={`Preview ${item.title}`}>
      <div className="canvas-preview-label"><span>{business.name}</span><span>{item.channel} preview</span></div>
      {row ? <ReviewMediaCard key={JSON.stringify(row)} businessId={business.id} row={row} canEdit={canEdit} copyApproved={revision?.status === "APPROVED"} onOpen={onOpen} onChange={onChange} /> : <p role="status">Loading saved creative…</p>}
      {revision && <div className="canvas-caption"><span className="eyebrow">COPY VERSION {revision.version}</span><h3>{revision.content.headline}</h3><p className="preserve-lines">{revision.content.caption}</p><p>{revision.content.cta}</p><details><summary>Creative direction & rationale</summary><p>{revision.content.visualDirection}</p><p>{revision.content.rationale}</p></details></div>}
      <p className="small muted">Your saved artwork or render—not a fabricated platform post. Approval does not publish.</p>
    </section>
    <aside className="canvas-delivery" aria-label={`Publishing details for ${item.title}`}>
      <h3>Publishing details</h3><p className="eyebrow">PLANNED DESTINATION</p><p>{item.channel}</p><p className="small muted">The destination label is not proof of a connected account or a published post.</p>
      {onConnections && <button className="button secondary" onClick={onConnections}>Manage publishing connections</button>}
      <hr /><h3>Schedule</h3>{!item.schedule && <p>Not on the calendar yet.</p>}
      {revision ? <ProductionCard item={item} brand={business} busy={busy || !canEdit} post={post} review section="schedule" /> : <p>Approve copy before reserving a calendar date.</p>}
      <hr /><h3>Quick edits</h3><button className="text-button" disabled={!canEdit} onClick={() => onOpen({ itemId: item.id, mode: "images" })}>Edit layout, branding & media</button><button className="text-button" disabled={!canEdit} onClick={() => onOpen({ itemId: item.id, mode: "video" })}>Open storyboard & video</button>
      <p className="small muted">Copy, artwork, layout and final video retain their own exact-version approvals.</p>
    </aside>
  </div>;
}
