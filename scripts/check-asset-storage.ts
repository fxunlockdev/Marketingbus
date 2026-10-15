import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { assetStore } from "../src/lib/assets/storage";
// An explicit operator probe: only a new synthetic object, never a customer's path.
async function main() {
  const store = assetStore(); const key = `operator-probes/${randomUUID()}.webp`;
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#c67139" } }).webp().toBuffer();
  try {
    await store.put(key, image);
    const result = await store.get(key);
    if (!Buffer.from(result).equals(image)) throw Error("Readback mismatch");
    console.info("Private storage write/read verified; synthetic probe cleanup follows.");
  } finally { await store.remove(key); }
  console.info("Synthetic probe deleted. No customer data or AI provider was used.");
}
void main().catch(() => { console.error("Private storage verification failed; inspect configuration without logging credentials."); process.exitCode = 1; });
