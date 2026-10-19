"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { type ProductionItemView } from "./production-card";
import { CreativeReviewCanvas } from "./creative-review-canvas";
import { HistoricalCreative } from "./plan-history";
import { ReviewMediaCard } from "./review-media";
import type { ReviewMedia } from "@/lib/production/review";
import type { AssetTarget } from "./asset-studio";

export function ReviewInbox({ business, planId, items, readOnly, busy, post, onOpen, onConnections }: {
  business: { id: string; name: string; color: string; designPreset: string; channels: string[] };
  planId?: string; items: ProductionItemView[]; readOnly: boolean; busy: boolean;
  post: (data: Record<string, unknown>) => Promise<unknown>; onOpen: (target: AssetTarget) => void; onConnections?: () => void;
}) {
  const router = useRouter();
  const [channel, setChannel] = useState("all"), [media, setMedia] = useState<ReviewMedia | null>(null);
  const [format, setFormat] = useState("all");
  const [loading, setLoading] = useState(false), [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  const [notice, setNotice] = useState("");
  const outcome = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (notice) outcome.current?.focus(); }, [notice, refresh]);
  const sourceVersion = items.map(i => `${i.id}:${i.revisions[0]?.id}:${i.revisions[0]?.status}`).join("|");
  useEffect(() => {
    const abort = new AbortController(); setMedia(null); setError("");
    if (!planId) { setLoading(false); return () => abort.abort(); }
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch(`/api/businesses/${business.id}/review?plan=${encodeURIComponent(planId)}`, { signal: abort.signal });
        const data = await response.json(); if (!response.ok) throw Error(data.error);
        if (!abort.signal.aborted) setMedia(data);
      } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Unable to load saved media."); }
      finally { if (!abort.signal.aborted) setLoading(false); }
    })(); return () => abort.abort();
  }, [business.id, planId, sourceVersion, refresh]);
  const channels = [...new Set([...business.channels, ...items.map(i => i.channel)])];
  const reviewable = items.filter(i => i.revisions.length || media?.items.some(m => m.itemId === i.id && (m.image || m.composition || m.video)));
  const visible = reviewable.filter(i => (channel === "all" || i.channel === channel) && (format === "all" || i.format === format));
  return <div className="production-list">
    <section className="panel" aria-label="Review destinations">
      <h2>Review by publishing destination</h2>
      <p>The same creation workspace serves every format. Here, each draft stays with its planned destination and exact saved versions. A destination label does not mean an account is connected or a post is published.</p>
      <div className="tag-row review-platform-filter" role="group" aria-label="Filter review by platform">
        {["all", ...channels].map(value => <button type="button" key={value} className={`button ${channel === value ? "dark" : "secondary"}`} aria-pressed={channel === value} aria-label={value === "all" ? "All platforms" : value} onClick={() => setChannel(value)}>{value === "all" ? "All platforms" : value} <span aria-hidden="true">({value === "all" ? reviewable.length : reviewable.filter(i => i.channel === value).length})</span></button>)}
      </div>
      <div className="tag-row review-platform-filter" role="group" aria-label="Filter review by format">
        {[{ value: "all", label: "All formats" }, { value: "static", label: "Images & posts" }, { value: "motion", label: "Video & motion" }].map(f => <button type="button" key={f.value} className={`button ${format === f.value ? "dark" : "secondary"}`} aria-pressed={format === f.value} onClick={() => setFormat(f.value)}>{f.label}</button>)}
      </div>
      <p role="status">{loading ? "Loading saved media…" : `${visible.length} creative${visible.length === 1 ? "" : "s"} shown${channel === "all" ? " across all platforms" : ` for ${channel}`}.`}</p>
      <p role="alert" className="error">{error}</p>
      <p ref={outcome} tabIndex={-1} role="status">{notice}</p>
      <button className="text-button" type="button" disabled={loading || !planId} onClick={() => setRefresh(v => v + 1)}>Refresh saved media</button>
    </section>
    {!visible.length && !loading && <section className="panel"><h2>Nothing matches this view yet.</h2><p>Choose another platform or format, or create assets for a planned creative. Produced copy, saved layouts and storyboards appear here; a planning outline is not a finished creative.</p>{(channel !== "all" || format !== "all") && <button className="button secondary" onClick={() => { setChannel("all"); setFormat("all"); }}>Show all creatives</button>}</section>}
    {visible.map(item => {
      const row = media?.items.find(m => m.itemId === item.id);
      const copyChanged = !!row && row.copyRevisionId !== (item.revisions[0]?.id ?? null);
      return <article key={item.id} className="platform-review-card" aria-label={`${item.channel}: ${item.title}`}>
        <div className="platform-review-label"><span className="eyebrow">{item.channel}</span><span>{item.format === "static" ? "Image / post" : "Video / motion"}</span></div>
        {readOnly || copyChanged ? <HistoricalCreative item={item} /> : <CreativeReviewCanvas key={`${item.id}:${item.revisions[0]?.version}`} item={item} business={business} row={row} canEdit={!!media?.canEdit} busy={busy} post={post} onOpen={onOpen} onConnections={onConnections} onChange={message => { setNotice(message); setRefresh(v => v + 1); }} />}
        {copyChanged && <section className="panel"><p role="status">Saved copy changed since this plan was loaded. Reload it before comparing or approving media.</p><button className="button" onClick={() => router.refresh()}>Reload current plan</button></section>}
        {readOnly && row && !copyChanged && <ReviewMediaCard key={JSON.stringify(row)} businessId={business.id} row={row} canEdit={false} copyApproved={item.revisions[0]?.status === "APPROVED"} onOpen={onOpen} onChange={message => { setNotice(message); setRefresh(v => v + 1); }} />}
      </article>;
    })}
  </div>;
}
