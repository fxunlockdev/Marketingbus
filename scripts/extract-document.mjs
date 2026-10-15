// Isolated text extraction only. No secrets, filesystem writes, networking or child processes.
// Node 26 permission mode is required by the parent; this is not a general office renderer.
const kind = process.argv[2];
const chunks = []; let length = 0;
for await (const chunk of process.stdin) {
  length += chunk.length;
  if (length > 5 * 1024 * 1024) throw Error("DOCUMENT_TOO_LARGE");
  chunks.push(chunk);
}
const buffer = Buffer.concat(chunks);
let text = "";
if (kind === "pdf") {
  if (buffer.subarray(0, 5).toString() !== "%PDF-") throw Error("INVALID_PDF");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, useWorkerFetch: false, disableFontFace: true, isOffscreenCanvasSupported: false, verbosity: 0, stopAtErrors: true });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 40) throw Error("TOO_MANY_PAGES");
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n), content = await page.getTextContent();
      text += content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("") + "\n\n";
      if (Buffer.byteLength(text) > 24000) throw Error("TEXT_TOO_LONG");
      page.cleanup();
    }
  } finally { await task.destroy(); }
} else if (kind === "docx") {
  if (buffer.readUInt32LE(0) !== 0x04034b50) throw Error("INVALID_DOCX");
  const { default: mammoth } = await import("mammoth");
  text = (await mammoth.extractRawText({ buffer })).value;
} else throw Error("UNSUPPORTED_DOCUMENT");
text = text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
if (text.length < 20 || /\uFFFD/.test(text)) throw Error("NO_USABLE_TEXT");
if (Buffer.byteLength(text) > 24000) throw Error("TEXT_TOO_LONG");
process.stdout.write(JSON.stringify({ text }));
