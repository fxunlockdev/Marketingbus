import { createHash } from "node:crypto";
import { AppError } from "../http";
export const MOTION_RENDERER_VERSION = "motion-cards-v1";
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
export function motionConfigurationHash() {
  return createHash("sha256").update(JSON.stringify({ version: MOTION_RENDERER_VERSION, enabled: process.env.MOTION_RENDERING_ENABLED, daily: process.env.MOTION_RENDER_DAILY_LIMIT, ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH })).digest("hex");
}
export function motionDailyLimit() {
  const limit = Number(process.env.MOTION_RENDER_DAILY_LIMIT);
  if (process.env.MOTION_RENDERING_ENABLED !== "true" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError(503, "Local motion rendering is paused or has no operator-approved daily limit.");
  return limit;
}
export const motionHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
