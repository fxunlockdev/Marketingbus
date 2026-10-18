import { createHiggsfieldTransport, higgsfieldRequest, type HiggsfieldInput, type HiggsfieldSettings } from "../providers/higgsfield";
import { downloadProviderMedia, type MediaDownload } from "../providers/media-download";
import type { ShotAdapter, ShotRoute } from "./generation-contracts";

export const HIGGSFIELD_SHOT_VERSION = "higgsfield-silent-v1";

// Concrete network/job bridge. It is deliberately not registered by credentials
// alone: the provider's status response does not supply verified final expense.
// Terminal outcomes stop at reconciliation, never a fabricated cost or delivery.
export function createHiggsfieldShotAdapter(settings: HiggsfieldSettings, fetcher: typeof fetch = fetch, download: MediaDownload = downloadProviderMedia): ShotAdapter {
  const client = createHiggsfieldTransport(settings, fetcher, download);
  function input(requestId: string, prompt: string, route: ShotRoute): HiggsfieldInput {
    if (route.provider !== "higgsfield" || route.accountId !== client.credentialFingerprint || route.adapterVersion !== HIGGSFIELD_SHOT_VERSION || new Date(route.verifiedUntil).getTime() <= Date.now() || new Date(route.verifiedUntil).getTime() > new Date(settings.verifiedUntil).getTime()) throw Error("Generated-shot provider binding changed.");
    return higgsfieldRequest({ operationId: requestId, prompt, durationMs: route.durationMs, model: route.model as HiggsfieldInput["model"] }).input;
  }
  return {
    id: "higgsfield", accountId: client.credentialFingerprint, version: HIGGSFIELD_SHOT_VERSION,
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
      // Avoid transferring media that cannot yet be admitted into normalization.
      const result = await client.poll(receipt, args.signal, { downloadCompleted: false });
      const binding = { requestId: args.requestId, providerJobId: args.providerJobId, accountId: client.credentialFingerprint, model: args.route.model };
      return result.state === "pending" ? { ...binding, status: "pending" } : { ...binding, status: "unverified", providerState: result.state };
    },
  };
}
