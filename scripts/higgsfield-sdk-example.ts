// Standalone operator demonstration, NOT the application's billed job workflow.
// Default is a no-network configuration check. Explicit --run-paid-demo spends
// supplier balance outside customer credits; never run it in a web request.
import { config as loadEnv } from "dotenv";
import { createHiggsfieldClient } from "@higgsfield/client/v2";
import { higgsfieldCredentials } from "../src/lib/providers/higgsfield-credentials";

loadEnv({ path: ".env.local", quiet: true });
async function main() {
  const credentials = higgsfieldCredentials();
  if (process.argv.slice(2).some(arg => arg !== "--run-paid-demo")) throw Error("Unsupported argument.");
  if (!process.argv.includes("--run-paid-demo")) {
    console.log("Higgsfield credentials have valid syntax. No network call or charge. Account access is not yet verified.");
    return;
  }
  // This published SDK still requires the older paired format. Production REST
  // accepts the complete opaque key too; do not manufacture a secret for it.
  if (credentials.apiKey) throw Error("Use the production REST workflow for this credential format.");
  const client = createHiggsfieldClient({ credentials: `${credentials.keyId}:${credentials.secret}`, maxRetries: 0, timeout: 15000, maxPollTime: 600000 });
  const result = await client.subscribe("bytedance/seedance-2.5/text-to-video", {
    input: { prompt: "A cinematic scene at sunset", duration: 5, resolution: "720p", aspect_ratio: "16:9", output_format: "mp4", generate_audio: true }, withPolling: true,
  });
  // Published @higgsfield/client 0.2.6 returns the raw V2Response.
  if (result.status !== "completed" || !result.video?.url) throw Error("Generation did not return a completed video.");
  const url = new URL(result.video.url);
  if (url.protocol !== "https:" || url.username || url.password) throw Error("Unexpected video URL.");
  console.log("Video completed. Retrieve the media in the Higgsfield dashboard; its signed URL is not printed.");
}
void main().catch(() => {
  // SDK errors may contain request headers or payloads. Never print raw errors.
  console.error("Higgsfield check did not complete. Verify configuration or inspect the provider dashboard. Do not repeat a paid request without checking whether it was accepted.");
  process.exitCode = 1;
});
