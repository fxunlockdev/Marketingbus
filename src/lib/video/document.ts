import { z } from "zod";
import { VIDEO_FORMATS } from "./layout";
export const assetRef = z.object({ id: z.string().min(1).max(100), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const soundtrack = assetRef.extend({
  startMs: z.number().int().min(0).max(29000).multipleOf(250),
  gainPercent: z.number().int().min(5).max(100).multipleOf(5),
  fadeInMs: z.number().int().min(0).max(2000).multipleOf(250),
  fadeOutMs: z.number().int().min(0).max(2000).multipleOf(250),
}).strict();
export const clipEdit = z.object({
  startMs: z.number().int().min(0).max(7000).multipleOf(250),
  fit: z.enum(["contain", "cover"]),
  x: z.number().int().min(0).max(100).multipleOf(5),
  y: z.number().int().min(0).max(100).multipleOf(5),
}).strict();
export const DEFAULT_CLIP_EDIT: z.infer<typeof clipEdit> = { startMs: 0, fit: "contain", x: 50, y: 50 };
export const videoShot = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/), label: z.string().trim().min(1).max(80),
  caption: z.string().trim().min(1).max(120), durationMs: z.number().int().min(1000).max(8000).multipleOf(250),
  motion: z.enum(["hold", "fade"]), asset: assetRef.nullable(),
  clip: assetRef.nullable().optional(),
  clipEdit: clipEdit.optional(),
}).strict().refine(s => !(s.clip && s.asset), "Choose an image or a clip for each scene, not both.")
  .refine(s => !s.clipEdit || !!s.clip, "Choose footage before setting a trim or crop.")
  .refine(s => !s.clip || (s.clipEdit?.startMs ?? 0) + s.durationMs <= 8000, "The selected footage range must end within eight seconds.")
  .refine(s => s.caption.length / (s.durationMs / 1000) <= 24, "Allow more reading time or shorten the caption (at most 24 characters per second).");
export const storyboardDocument = z.object({
  title: z.string().trim().min(1).max(100), background: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  // Optional preserves legacy document hashes; omitted means the original portrait layout.
  format: z.enum(VIDEO_FORMATS).optional(),
  soundtrack: soundtrack.nullable().optional(),
  logo: assetRef.nullable(), shots: z.array(videoShot).min(1).max(6),
}).strict().refine(d => d.shots.reduce((n, s) => n + s.durationMs, 0) <= 30000, "Keep the complete reel within 30 seconds.")
  .refine(d => new Set(d.shots.map(s => s.id)).size === d.shots.length, "Each shot needs a unique identifier.")
  .refine(d => !d.soundtrack || d.soundtrack.startMs + d.shots.reduce((n, s) => n + s.durationMs, 0) <= 30000, "The music range must end within 30 seconds.")
  .refine(d => !d.soundtrack || d.soundtrack.fadeInMs + d.soundtrack.fadeOutMs <= d.shots.reduce((n, s) => n + s.durationMs, 0), "Music fades cannot overlap.");
export type StoryboardDocument = z.infer<typeof storyboardDocument>;
export type VideoShot = z.infer<typeof videoShot>;
export const shotApprovals = z.array(z.object({ shotId: z.string(), hash: z.string(), reviewer: z.string(), at: z.string() }).strict()).max(6);
export function totalDuration(document: StoryboardDocument) { return document.shots.reduce((n, s) => n + s.durationMs, 0); }
export function soundtrackRangeFits(document: StoryboardDocument, durationMs: number) { return !!document.soundtrack && Number.isSafeInteger(durationMs) && document.soundtrack.startMs + totalDuration(document) <= durationMs; }
export function shotTimeline(document: StoryboardDocument) {
  let elapsed = 0;
  return document.shots.map(shot => {
    const startMs = elapsed; elapsed += shot.durationMs;
    const sourceStartMs = shot.clip ? (shot.clipEdit?.startMs ?? 0) : null;
    return { id: shot.id, label: shot.label, startMs, endMs: elapsed, sourceStartMs, sourceEndMs: sourceStartMs === null ? null : sourceStartMs + shot.durationMs };
  });
}
export function clipRangeFits(shot: VideoShot, clipDurationMs: number) {
  return !!shot.clip && videoShot.safeParse(shot).success && Number.isSafeInteger(clipDurationMs) && (shot.clipEdit?.startMs ?? 0) + shot.durationMs <= clipDurationMs;
}
export function subtitleVtt(document: StoryboardDocument) {
  let elapsed = 0;
  const time = (ms: number) => `00:${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
  return "WEBVTT\n\n" + document.shots.map((shot, index) => { const start = elapsed; elapsed += shot.durationMs;
    // No markup or timing syntax from customer captions enters the VTT parser.
    return `${index + 1}\n${time(start)} --> ${time(elapsed)}\n${shot.caption.replace(/[\r\n]+/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}\n`;
  }).join("\n");
}
