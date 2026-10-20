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
} else if (kind === "pptx") {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw Error("INVALID_PPTX");
  const { default: JSZip } = await import("jszip");
  const { DOMParser } = await import("@xmldom/xmldom");
  const zip = await JSZip.loadAsync(buffer);
  if (Object.keys(zip.files).length > 1000) throw Error("TOO_MANY_PARTS");
  async function xml(path) {
    const file = zip.file(path); if (!file) throw Error("MISSING_PART");
    let total = 0; const chunks = [];
    await new Promise((ok, fail) => {
      const stream = file.nodeStream();
      stream.on("data", chunk => { total += chunk.length; if (total > 1024 * 1024) stream.destroy(Error("PART_TOO_LARGE")); else chunks.push(chunk); });
      stream.on("end", ok); stream.on("error", fail);
    });
    const source = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw Error("UNSAFE_XML");
    return new DOMParser({ errorHandler: { warning() {}, error() { throw Error("INVALID_XML"); }, fatalError() { throw Error("INVALID_XML"); } } }).parseFromString(source, "text/xml");
  }
  const presentation = await xml("ppt/presentation.xml"), relationships = await xml("ppt/_rels/presentation.xml.rels");
  const slideIds = Array.from(presentation.getElementsByTagNameNS("http://schemas.openxmlformats.org/presentationml/2006/main", "sldId"));
  if (!slideIds.length || slideIds.length > 40) throw Error("SLIDE_LIMIT");
  const rels = Array.from(relationships.getElementsByTagNameNS("http://schemas.openxmlformats.org/package/2006/relationships", "Relationship"));
  const seen = new Set();
  for (const slide of slideIds) {
    const id = slide.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const matches = rels.filter(r => r.getAttribute("Id") === id);
    if (matches.length !== 1) throw Error("INVALID_RELATIONSHIP");
    const rel = matches[0], target = rel.getAttribute("Target");
    if (rel.getAttribute("TargetMode") === "External" || !/^slides\/slide\d+\.xml$/.test(target) || seen.has(target)) throw Error("INVALID_SLIDE");
    seen.add(target);
    const doc = await xml(`ppt/${target}`);
    text += Array.from(doc.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "p"))
      .map(p => Array.from(p.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "t")).map(t => t.textContent).join("")).join("\n") + "\n\n";
    if (Buffer.byteLength(text) > 24000) throw Error("TEXT_TOO_LONG");
  }
} else throw Error("UNSUPPORTED_DOCUMENT");
text = text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
if (text.length < 20 || /\uFFFD/.test(text)) throw Error("NO_USABLE_TEXT");
if (Buffer.byteLength(text) > 24000) throw Error("TEXT_TOO_LONG");
process.stdout.write(JSON.stringify({ text }));
