// Read-only inventory. Archive contents are data, never installed or executed.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import JSZip from "jszip";
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
async function main() {
 const result = [];
 for (const path of process.argv.slice(2)) {
  const bytes = await readFile(path), zip = await JSZip.loadAsync(bytes);
  const files = [];
  for (const file of Object.values(zip.files).filter(f => !f.dir && !f.name.startsWith("__MACOSX/")).sort((a, b) => a.name.localeCompare(b.name))) {
   const data = await file.async("nodebuffer");
   files.push({ path: file.name, bytes: data.length, sha256: digest(data), entrypoint: /(^|\/)(SKILL\.md|README\.md|LICENSE[^/]*)$/.test(file.name) });
  }
  result.push({ archive: basename(path), archiveSha256: digest(bytes), fileCount: files.length, files });
 }
 process.stdout.write(JSON.stringify({ note: "Byte inventory, not a semantic review or runtime-integration claim. No code executed.", archives: result }, null, 2) + "\n");
}
main().catch(() => { console.error("Supplied-pack inventory failed; check local archive availability."); process.exitCode = 1; });
