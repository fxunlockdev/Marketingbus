import { z } from "zod";
export const assetRef = z.object({ id: z.string().min(1).max(100), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const videoShot = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/), label: z.string().trim().min(1).max(80),
  caption: z.string().trim().min(1).max(120), durationMs: z.number().int().min(1000).max(8000).multipleOf(250),
  motion: z.enum(["hold", "fade"]), asset: assetRef.nullable(),
}).strict().refine(s => s.caption.length / (s.durationMs / 1000) <= 24, "Allow more reading time or shorten the caption (at most 24 characters per second).");
export const storyboardDocument = z.object({
  title: z.string().trim().min(1).max(100), background: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  logo: assetRef.nullable(), shots: z.array(videoShot).min(1).max(6),
}).strict().refine(d => d.shots.reduce((n, s) => n + s.durationMs, 0) <= 30000, "Keep the complete reel within 30 seconds.")
  .refine(d => new Set(d.shots.map(s => s.id)).size === d.shots.length, "Each shot needs a unique identifier.");
export type StoryboardDocument = z.infer<typeof storyboardDocument>;
export type VideoShot = z.infer<typeof videoShot>;
export const shotApprovals = z.array(z.object({ shotId: z.string(), hash: z.string(), reviewer: z.string(), at: z.string() }).strict()).max(6);
export function totalDuration(document: StoryboardDocument) { return document.shots.reduce((n, s) => n + s.durationMs, 0); }
export function subtitleVtt(document: StoryboardDocument) {
  let elapsed = 0;
  const time = (ms: number) => `00:${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
  return "WEBVTT\n\n" + document.shots.map((shot, index) => { const start = elapsed; elapsed += shot.durationMs;
    // No markup or timing syntax from customer captions enters the VTT parser.
    return `${index + 1}\n${time(start)} --> ${time(elapsed)}\n${shot.caption.replace(/[\r\n]+/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}\n`;
  }).join("\n");
}
