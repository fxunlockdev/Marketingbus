import { z } from "zod";
import { AppError } from "../http";

export const MAX_SHOT_TAKES = 4;
export const shotDirection = z.string().trim().max(1000);
export const shotFeedback = z.string().trim().min(10).max(1000);
const identifier = z.string().min(1).max(100);
export const shotCreativeBrief = z.object({
  version: z.literal(1), direction: shotDirection,
  revisions: z.array(z.object({ parentId: identifier, feedback: shotFeedback }).strict()).max(MAX_SHOT_TAKES),
}).strict().refine(v => new Set(v.revisions.map(r => r.parentId)).size === v.revisions.length, "Repeated revision source.");
export type ShotCreativeBrief = z.infer<typeof shotCreativeBrief>;
export function readShotBrief(raw: unknown): ShotCreativeBrief {
  // Only the exact pre-migration default is legacy; malformed metadata never becomes an empty brief.
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 0) return { version: 1, direction: "", revisions: [] };
  return shotCreativeBrief.parse(raw);
}
export function nextShotBrief(parentId: string, raw: unknown, feedback: string): ShotCreativeBrief {
  const parent = readShotBrief(raw);
  if (parent.revisions.length >= MAX_SHOT_TAKES) throw new AppError(409, "Four feedback-driven takes already exist in this direction chain. Review the storyboard and start a new direction deliberately.");
  return shotCreativeBrief.parse({ ...parent, revisions: [...parent.revisions, { parentId, feedback }] });
}
export function validateShotBriefBinding(raw: unknown, revisionOfId: string | null) {
  const brief = readShotBrief(raw);
  if ((brief.revisions.at(-1)?.parentId ?? null) !== revisionOfId) throw new AppError(409, "Generated-shot direction history differs. Request a fresh quote.");
  return brief;
}
