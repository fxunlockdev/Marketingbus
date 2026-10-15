import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod";
import { AppError } from "../http";
export const DOCUMENT_BYTE_LIMIT = 5 * 1024 * 1024;
let active = 0;
export async function extractDocument(bytes: Uint8Array, kind: "pdf" | "docx") {
  if (!bytes.length || bytes.length > DOCUMENT_BYTE_LIMIT) throw new AppError(413, "Use a document up to 5 MB.");
  if (Number(process.versions.node.split(".")[0]) < 26) throw new AppError(503, "Document extraction requires the isolated Node 26 runtime.");
  if (active >= 2) throw new AppError(503, "Document extraction is busy. Please retry shortly.");
  active++;
  try {
    return await new Promise<string>((accept, reject) => {
      const root = process.cwd(), script = resolve(root, "scripts/extract-document.mjs");
      const child = spawn(process.execPath, ["--permission", "--allow-addons", `--allow-fs-read=${resolve(root, "node_modules")}`, `--allow-fs-read=${script}`, "--max-old-space-size=192", "--disallow-code-generation-from-strings", script, kind], {
        cwd: root, env: { NODE_ENV: "production", LANG: "C.UTF-8", TZ: "UTC" }, stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks: Buffer[] = []; let count = 0, stopped = false;
      const fail = () => {
        if (stopped) return; stopped = true; child.kill("SIGKILL");
        reject(new AppError(422, "Cannot extract this document. Use an unlocked PDF with selectable text (up to 40 pages) or a DOCX file, containing 20 characters to 24 KB of text. Scans, damaged files and complex files may require a text export."));
      };
      const timer = setTimeout(fail, 15000);
      child.on("error", fail);
      child.stdout.on("data", (chunk: Buffer) => { count += chunk.length; if (count > 150000) fail(); else chunks.push(chunk); });
      // Drain diagnostics without storing or exposing potentially sensitive document contents.
      child.stderr.on("data", () => {});
      child.stdin.on("error", () => {});
      child.on("close", code => {
        clearTimeout(timer); if (stopped) return;
        if (code !== 0) return fail();
        try {
          const output = z.object({ text: z.string().min(20).max(24000) }).strict().parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          if (Buffer.byteLength(output.text) > 24000) return fail();
          stopped = true; accept(output.text);
        } catch { fail(); }
      });
      child.stdin.end(bytes);
    });
  } finally { active--; }
}
