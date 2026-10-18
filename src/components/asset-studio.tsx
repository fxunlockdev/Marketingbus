"use client";
import { useState } from "react";
import { Image, Film, FolderOpen } from "lucide-react";
import { CompositionEditor } from "./composition-editor";
import { VideoStudio } from "./video-studio";
import { AssetLibrary } from "./asset-library";
import type { ProductionItemView } from "./production-card";

export type AssetMode = "images" | "video" | "library";
export type AssetTarget = { itemId: string; mode: AssetMode };
const modes = [
  { id: "images", label: "Images & design", icon: Image, description: "Supporting artwork, exact brand assets and editable layouts." },
  { id: "video", label: "Video & motion", icon: Film, description: "Generated footage, storyboards, motion, music and finished reels." },
  { id: "library", label: "Brand asset library", icon: FolderOpen, description: "Your original logos, product photos and approved references." },
] as const;

export function AssetStudio({ businessId, items, canCreate, target, onReview }: {
  businessId: string; items: ProductionItemView[]; canCreate: boolean; target?: AssetTarget; onReview: () => void;
}) {
  const [mode, setMode] = useState<AssetMode>(target?.mode ?? "images");
  const [visited, setVisited] = useState<AssetMode[]>([target?.mode ?? "images"]);
  const selected = items.find(i => i.id === target?.itemId);
  function chooseMode(next: AssetMode) {
    if (next !== mode) document.getElementById(`asset-panel-${mode}`)?.querySelectorAll<HTMLMediaElement>("video, audio").forEach(media => media.pause());
    setMode(next); setVisited(v => v.includes(next) ? v : [...v, next]);
  }
  return <div className="production-list">
    <section className="panel asset-studio-intro" aria-label="Creation workspace">
      <div><h2>One brief. Every format.</h2><p>{selected ? `Continue “${selected.title}” for ${selected.channel}. ` : "Create from your confirmed brand and planned work. "}Review the finished versions by destination before scheduling.</p></div>
      <button type="button" className="button secondary" onClick={onReview}>Review by platform</button>
    </section>
    <div className="asset-mode-grid" role="group" aria-label="Asset workflow">
      {modes.map(({ id, label, icon: Icon, description }) => <button key={id} type="button" className="asset-mode" aria-pressed={mode === id} aria-controls={`asset-panel-${id}`} onClick={() => chooseMode(id)}>
        <Icon size={22} aria-hidden="true" /><strong>{label}</strong><span>{description}</span>
      </button>)}
    </div>
    {!canCreate && mode !== "library" && <section className="panel"><h2>Choose a current plan.</h2><p>Creation needs a confirmed brand, a current plan and editing access. Saved work remains available in Review inbox. The brand asset library is available without a plan.</p></section>}
    {/* Keep visited editors mounted so switching formats does not erase an unsaved draft. */}
    <section id="asset-panel-images" aria-label="Image creation" hidden={mode !== "images"}>
      {canCreate && visited.includes("images") && <CompositionEditor businessId={businessId} items={items} initialItemId={selected?.id} />}
    </section>
    <section id="asset-panel-video" aria-label="Video creation" hidden={mode !== "video"}>
      {canCreate && visited.includes("video") && <VideoStudio businessId={businessId} items={items} initialItemId={selected?.id} />}
    </section>
    <section id="asset-panel-library" aria-label="Original brand asset library" hidden={mode !== "library"}>
      {visited.includes("library") && <AssetLibrary businessId={businessId} />}
    </section>
  </div>;
}
