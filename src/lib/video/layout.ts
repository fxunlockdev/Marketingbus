// Shared finite layouts: no customer dimensions, HTML or FFmpeg filter expressions.
export const VIDEO_FORMATS = ["portrait", "square", "feed", "landscape"] as const;
export type VideoFormat = typeof VIDEO_FORMATS[number];
type Rect = { x: number; y: number; width: number; height: number };
type Layout = { label: string; width: number; height: number; logo: Rect; media: Rect; panel: Rect; text: Rect & { fontSize: number; lineHeight: number; maxLines: number } };
export const VIDEO_LAYOUTS: Record<VideoFormat, Layout> = {
  portrait: { label: "Portrait · 9:16", width: 720, height: 1280,
    logo: { x: 56, y: 70, width: 230, height: 130 }, media: { x: 56, y: 240, width: 608, height: 620 },
    panel: { x: 36, y: 906, width: 648, height: 310 }, text: { x: 62, y: 922, width: 596, height: 264, fontSize: 36, lineHeight: 44, maxLines: 6 } },
  square: { label: "Square · 1:1", width: 720, height: 720,
    logo: { x: 40, y: 30, width: 190, height: 96 }, media: { x: 40, y: 150, width: 640, height: 310 },
    panel: { x: 36, y: 490, width: 648, height: 194 }, text: { x: 62, y: 508, width: 596, height: 156, fontSize: 30, lineHeight: 36, maxLines: 4 } },
  feed: { label: "Feed · 4:5", width: 720, height: 900,
    logo: { x: 48, y: 40, width: 210, height: 100 }, media: { x: 48, y: 168, width: 624, height: 440 },
    panel: { x: 36, y: 644, width: 648, height: 220 }, text: { x: 62, y: 662, width: 596, height: 182, fontSize: 32, lineHeight: 40, maxLines: 4 } },
  landscape: { label: "Landscape · 16:9", width: 1280, height: 720,
    logo: { x: 40, y: 36, width: 200, height: 90 }, media: { x: 40, y: 160, width: 620, height: 504 },
    panel: { x: 690, y: 160, width: 550, height: 504 }, text: { x: 716, y: 190, width: 498, height: 440, fontSize: 36, lineHeight: 44, maxLines: 9 } },
};
export function videoLayout(document: { format?: VideoFormat }) { return VIDEO_LAYOUTS[document.format ?? "portrait"]; }
