"use client";
import type { StudioClip } from "./clip-library";
import { totalDuration, soundtrackRangeFits, type StoryboardDocument } from "@/lib/video/document";
export function SoundtrackEditor({ document, tracks, onChange }: { document: StoryboardDocument; tracks: StudioClip[]; onChange: (document: StoryboardDocument) => void }) {
  const music = document.soundtrack, selected = tracks.find(t => t.id === music?.id && t.usable && t.sha256 === music.sha256), invalid = !!music && (!selected || !soundtrackRangeFits(document, selected.durationMs));
  const change = (value: Partial<NonNullable<StoryboardDocument["soundtrack"]>>) => { if (music) onChange({ ...document, soundtrack: { ...music, ...value } }); };
  return <div>
    <label htmlFor="instrumental-soundtrack">Instrumental soundtrack</label><select id="instrumental-soundtrack" value={music?.id ?? ""} aria-describedby="soundtrack-help" onChange={e => { const track = tracks.find(t => t.id === e.target.value && t.usable); onChange({ ...document, soundtrack: track ? { id: track.id, sha256: track.sha256, startMs: 0, gainPercent: 25, fadeInMs: 250, fadeOutMs: 250 } : null }); }}>
      <option value="">No music · silent video</option>{music && !selected && <option value={music.id} disabled>Unavailable music · replace or remove</option>}{tracks.filter(t => t.usable).map(t => <option key={t.id} value={t.id}>{t.label} · {(t.durationMs / 1000).toFixed(2)}s</option>)}
    </select>
    <p id="soundtrack-help">Music covers the full {totalDuration(document) / 1000}s reel without looping or stretching. Choose a long enough source. Any music change requires fresh scene, storyboard and finished-video reviews. Listen to the final export before approval.</p>
    {music && <div className="composition-controls">
      <label>Music start (seconds)<input required type="number" min={0} max={29} step={0.25} value={music.startMs / 1000} aria-invalid={invalid} aria-describedby="music-range-help" onChange={e => change({ startMs: Math.round(Number(e.target.value) * 1000) })} /></label>
      <label>Music volume (%)<input required type="number" min={5} max={100} step={5} value={music.gainPercent} onChange={e => change({ gainPercent: Number(e.target.value) })} /></label>
      <label>Music fade in (seconds)<input required type="number" min={0} max={2} step={0.25} value={music.fadeInMs / 1000} onChange={e => change({ fadeInMs: Math.round(Number(e.target.value) * 1000) })} /></label>
      <label>Music fade out (seconds)<input required type="number" min={0} max={2} step={0.25} value={music.fadeOutMs / 1000} onChange={e => change({ fadeOutMs: Math.round(Number(e.target.value) * 1000) })} /></label>
      <p id="music-range-help" role={invalid ? "alert" : undefined}>{invalid ? "Choose current approved music long enough for the selected range, or remove it." : `Music range: ${music.startMs / 1000}–${(music.startMs + totalDuration(document)) / 1000}s of ${selected!.durationMs / 1000}s.`}</p>
    </div>}
  </div>;
}
