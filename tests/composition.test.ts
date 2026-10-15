import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  canvasDocument,
  initialCanvas,
  placements,
} from "../src/lib/composition/document";
import { renderCanvas } from "../src/lib/composition/render";
describe("deterministic editable compositions", () => {
  it("bounds concurrent rendering and releases slots after completion", async () => {
    const document = initialCanvas({ color: "#123456", designPreset: "editorial" }, []);
    const render = () => renderCanvas(document, "square", { brand: "Studio", headline: "Made for home", cta: "Meet us" }, new Map());
    const results = await Promise.allSettled([render(), render(), render()]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect((await render()).width).toBe(1080);
  });
  it("renders all placements with exact output dimensions", async () => {
    const document = initialCanvas(
      { color: "#123456", designPreset: "editorial" },
      []
    );
    for (const placement of Object.keys(
      placements
    ) as (keyof typeof placements)[]) {
      const rendered = await renderCanvas(
        document,
        placement,
        { brand: "Studio", headline: "Made for home", cta: "Meet us" },
        new Map()
      );
      const image = await sharp(rendered.png).metadata();
      expect([image.width, image.height]).toEqual(placements[placement]);
    }
  });
  it("escapes markup, rejects external image references and out-of-bounds layers", async () => {
    const document = initialCanvas(
      { color: "#123456", designPreset: "editorial" },
      []
    );
    const result = await renderCanvas(
      document,
      "square",
      { brand: "A & B", headline: "<script>", cta: "Explore" },
      new Map()
    );
    expect(result.svg.toString()).toContain("&lt;script&gt;");
    expect(result.svg.toString()).not.toContain("<script>");
    expect(() =>
      canvasDocument.parse({
        ...document,
        layers: [{ ...document.layers[0], x: 0.9, width: 0.9 }],
      })
    ).toThrow();
    expect(() =>
      canvasDocument.parse({
        ...document,
        layers: [{ kind: "image", url: "https://example.com/image" }],
      })
    ).toThrow();
  });
  it("refuses text overflow rather than clipping it silently", async () => {
    const document = initialCanvas(
      { color: "#123456", designPreset: "bold" },
      []
    );
    document.layers = [
      {
        kind: "text",
        field: "headline",
        x: 0.1,
        y: 0.1,
        width: 0.2,
        height: 0.1,
        fontSize: 0.06,
        color: "#ffffff",
      },
    ];
    await expect(
      renderCanvas(
        document,
        "square",
        {
          brand: "Test",
          headline: "This is too much copy for the box",
          cta: "",
        },
        new Map()
      )
    ).rejects.toThrow();
  });
});
