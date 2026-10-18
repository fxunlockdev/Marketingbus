import { createHash } from "node:crypto";
import { createHiggsfieldTransport, higgsfieldRequest, type HiggsfieldInput, type HiggsfieldSettings } from "../providers/higgsfield";
import { downloadProviderMedia, type MediaDownload } from "../providers/media-download";
import type { ShotAdapter, ShotRoute } from "./generation-contracts";

export const HIGGSFIELD_SHOT_VERSION = "higgsfield-silent-v1";
export const HIGGSFIELD_QUOTED_VERSION = "higgsfield-account-quote-v1";
type ExpensePolicy = "final" | "account-quote-v1";

// Explicit quote policy allows bounded delivery while keeping invoice expense
// separately unreconciled. Credentials alone never enable this policy.
export function createHiggsfieldShotAdapter(settings: HiggsfieldSettings, fetcher: typeof fetch = fetch, download: MediaDownload = downloadProviderMedia, expensePolicy: ExpensePolicy = "final"): ShotAdapter {
  const client = createHiggsfieldTransport(settings, fetcher, download);
  const version = expensePolicy === "account-quote-v1" ? HIGGSFIELD_QUOTED_VERSION : HIGGSFIELD_SHOT_VERSION;
  function input(requestId: string, prompt: string, route: ShotRoute): HiggsfieldInput {
    if ((route.expensePolicy ?? "final") !== expensePolicy || route.provider !== "higgsfield" || route.accountId !== client.credentialFingerprint || route.adapterVersion !== version || new Date(route.verifiedUntil).getTime() <= Date.now() || new Date(route.verifiedUntil).getTime() > new Date(settings.verifiedUntil).getTime()) throw Error("Generated-shot provider binding changed.");
    return higgsfieldRequest({ operationId: requestId, prompt, durationMs: route.durationMs, model: route.model as HiggsfieldInput["model"] }).input;
  }
  return {
    id: "higgsfield", accountId: client.credentialFingerprint, version,
    supports(route) { try { input("route-validation", "Route validation only; no HTTP.", { ...route, credits: 1 }); return true; } catch { return false; } },
    async prepare(args) {
      const request = input(args.requestId, args.prompt, args.route);
      const estimate = await client.estimate(request, args.signal);
      if (estimate.estimatedUsdMicros > args.route.ceilingMicros) throw Error("Generated-shot estimate exceeds authorization.");
      return JSON.stringify(estimate);
    },
    async submit(args) {
      const request = input(args.requestId, args.prompt, args.route);
      if (!args.preparation || args.preparation.length > 8192) throw Error("Generated-shot estimate is unavailable.");
      const receipt = await client.submit(request, JSON.parse(args.preparation), args.route.ceilingMicros, args.signal);
      return { requestId: args.requestId, providerJobId: receipt.providerJobId, accountId: client.credentialFingerprint, journal: JSON.stringify(receipt) };
    },
    async poll(args) {
      const request = input(args.requestId, args.prompt, args.route);
      if (!args.journal || args.journal.length > 8192) throw Error("Generated-shot submission journal is unavailable.");
      const receipt = client.bindSubmission(JSON.parse(args.journal), request);
      if (receipt.providerJobId !== args.providerJobId || receipt.estimatedUsdMicros > args.route.ceilingMicros) throw Error("Generated-shot submission journal differs.");
      const result = await client.poll(receipt, args.signal, { downloadCompleted: expensePolicy === "account-quote-v1" });
      const binding = { requestId: args.requestId, providerJobId: args.providerJobId, accountId: client.credentialFingerprint, model: args.route.model };
      if (result.state === "pending") return { ...binding, status: "pending" };
      if (expensePolicy === "final") return { ...binding, status: "unverified", providerState: result.state };
      if (result.state !== "completed") return { ...binding, status: "provisional-failed", estimatedCostMicros: 0, providerState: result.state };
      if (!("bytes" in result) || !result.bytes) throw Error("Generated-shot output is unavailable.");
      return { ...binding, status: "provisional-succeeded", estimatedCostMicros: receipt.estimatedUsdMicros, bytes: result.bytes };
    },
  };
}

function configuredSettings() {
  return {
    keyId: process.env.HIGGSFIELD_API_KEY || "", secret: process.env.HIGGSFIELD_API_SECRET || "",
    verifiedUntil: process.env.HIGGSFIELD_VERIFIED_UNTIL || "",
    outputHosts: JSON.parse(process.env.HIGGSFIELD_OUTPUT_HOSTS_JSON || "[]") as string[],
  };
}
export function higgsfieldConfigurationFingerprint() {
  const enabled = process.env.HIGGSFIELD_VIDEO_ENABLED === "true";
  // Only this digest enters the shared worker/quote fingerprint. No secrets are returned.
  return createHash("sha256").update(JSON.stringify(enabled ? {
    enabled, key: process.env.HIGGSFIELD_API_KEY, secret: process.env.HIGGSFIELD_API_SECRET,
    until: process.env.HIGGSFIELD_VERIFIED_UNTIL, hosts: process.env.HIGGSFIELD_OUTPUT_HOSTS_JSON,
    policy: process.env.HIGGSFIELD_EXPENSE_POLICY, version: HIGGSFIELD_QUOTED_VERSION,
  } : { enabled })).digest("hex");
}
export function configuredHiggsfieldAdapters(): ShotAdapter[] {
  if (process.env.HIGGSFIELD_VIDEO_ENABLED !== "true") return [];
  if (process.env.HIGGSFIELD_EXPENSE_POLICY !== "account-quote-v1") throw Error("Explicit generated-video accounting policy required.");
  return [createHiggsfieldShotAdapter(configuredSettings(), fetch, downloadProviderMedia, "account-quote-v1")];
}
