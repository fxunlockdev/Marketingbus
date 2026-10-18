import { z } from "zod";
import { createLinkedInOAuthAdapter, LINKEDIN_SCOPES, type LinkedInOAuthSettings } from "./linkedin-oauth";
import { socialJson, SocialReadError } from "./provider-http";
import { publicationPayload, metricReading, metricSubject, MetricSourceChangedError, type MetricSubject, type Account, type SocialAdapter, type PublicationPayload, type PublishedReceipt } from "./contracts";
import { submissionJournal, type SubmissionJournal, type SubmissionContext } from "./submission-journal";
const company = z.string().regex(/^urn:li:organization:[1-9][0-9]{0,15}$/);
const postId = z.string().regex(/^urn:li:(share|ugcPost):[1-9][0-9]{0,30}$/);
const count = z.number().int().min(0).max(2147483647);
const likes = z.number().int().min(-2147483647).max(2147483647);
const failure = () => Error("LinkedIn publication or metrics could not be verified.");
export function createLinkedInPublishingAdapter(config: LinkedInOAuthSettings, fetcher: typeof fetch = fetch, journal: SubmissionJournal = submissionJournal): SocialAdapter {
  const version = `${createLinkedInOAuthAdapter(config).config.version}:publish-v1`;
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: "application/json", "LinkedIn-Version": config.apiVersion, "X-Restli-Protocol-Version": "2.0.0" });
  const get = (account: Account, path: string, signal: AbortSignal) => socialJson(fetcher, `https://api.linkedin.com/rest/${path}`, { headers: headers(account.token) }, signal);
  const context = (account: Account, payload: PublicationPayload, requestId: string): SubmissionContext => ({ account, payload, requestId, adapterVersion: version });
  const validatePayload = (account: Account, payload: PublicationPayload) => {
    publicationPayload.parse(payload); company.parse(account.externalAccountId);
    if (account.provider !== "LinkedIn" || payload.channel !== "LinkedIn" || payload.format !== "static" || payload.mediaExportId !== null) throw failure();
  };
  async function authorize(account: Account, signal: AbortSignal) {
    createLinkedInOAuthAdapter(config); company.parse(account.externalAccountId);
    if (account.provider !== "LinkedIn") throw failure();
    const grant = z.object({ active: z.literal(true), status: z.literal("active"), client_id: z.literal(config.clientId), auth_type: z.literal("3L"), expires_at: z.number().int().safe(), scope: z.string().max(4000) }).parse(await socialJson(fetcher, "https://www.linkedin.com/oauth/v2/introspectToken", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, token: account.token }) }, signal));
    if (grant.expires_at * 1000 <= Date.now() + 60000 || LINKEDIN_SCOPES.some(p => !grant.scope.split(/[\s,]+/).includes(p))) throw failure();
    // Only the application's supported administrator lane, rechecked before each write/read.
    for (let index = 0; index < 2; index++) {
      const acl = z.object({ elements: z.array(z.object({ role: z.literal("ADMINISTRATOR"), state: z.literal("APPROVED"), organization: company.optional(), organizationTarget: company.optional() })).max(10), paging: z.object({ start: z.literal(index * 10), count: z.literal(10), links: z.array(z.object({ rel: z.string().max(30) })).max(10) }) }).parse(await get(account, `organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=10&start=${index * 10}`, signal));
      if (acl.elements.some(e => e.organization && e.organizationTarget && e.organization !== e.organizationTarget)) throw failure();
      if (acl.elements.some(e => (e.organization ?? e.organizationTarget) === account.externalAccountId)) return;
      if (!acl.paging.links.some(p => p.rel === "next")) break;
    }
    throw failure();
  }
  async function readPost(account: Account, id: string, signal: AbortSignal, caption?: string, subject?: MetricSubject): Promise<PublishedReceipt> {
    postId.parse(id);
    const result = z.object({ id: z.literal(id), author: z.literal(account.externalAccountId), lifecycleState: z.string().max(100), commentary: z.string().max(64000), publishedAt: z.number().int().positive().safe(), visibility: z.string().max(100), distribution: z.object({ feedDistribution: z.string().max(100) }), content: z.record(z.string(), z.unknown()).optional(), reshareContext: z.record(z.string(), z.unknown()).optional(), adContext: z.record(z.string(), z.unknown()).optional() }).parse(await get(account, `posts/${encodeURIComponent(id)}?viewContext=READER`, signal));
    const eligible = result.lifecycleState === "PUBLISHED" && result.visibility === "PUBLIC" && result.distribution.feedDistribution === "MAIN_FEED" && Object.keys(result.content ?? {}).length === 0 && result.reshareContext === undefined && result.adContext === undefined;
    if (subject && (!eligible || result.commentary !== subject.payload.caption || result.publishedAt !== subject.publishedAt.getTime())) throw new MetricSourceChangedError();
    if (!eligible) throw failure();
    if (caption !== undefined && result.commentary !== caption || result.publishedAt > Date.now() + 60000) throw failure();
    return { externalPostId: id, publishedAt: new Date(result.publishedAt), permalink: null };
  }
  return {
    async publish(account, payload, requestId, signal) {
      try { validatePayload(account, payload); } catch { return { state: "failed", code: "INVALID_MEDIA" }; }
      try { await authorize(account, signal); }
      catch (error) {
        if (error instanceof SocialReadError && error.status === 401) return { state: "failed", code: "TOKEN_REVOKED" };
        if (error instanceof SocialReadError && [429, 500, 502, 503, 504].includes(error.status ?? 0)) return { state: "retryable", code: error.status === 429 ? "RATE_LIMIT" : "PROVIDER_UNAVAILABLE", retryAfterSeconds: 3600 };
        return { state: "failed", code: "PERMISSION_DENIED" };
      }
      // Commit the fence before ANY publish request; a lost response must never cause a retry.
      const ctx = context(account, payload, requestId);
      try {
        if (!await journal.begin(ctx)) return { state: "uncertain" };
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]); bounded.throwIfAborted();
        const response = await fetcher("https://api.linkedin.com/rest/posts", { method: "POST", headers: { ...headers(account.token), "Content-Type": "application/json" }, body: JSON.stringify({ author: account.externalAccountId, commentary: payload.caption, visibility: "PUBLIC", distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false }), signal: bounded, redirect: "error", cache: "no-store", credentials: "omit" });
        // Discard all response bodies, including error bodies that could contain secrets.
        const id = response.status === 201 ? postId.safeParse(response.headers.get("x-restli-id")) : null;
        await response.body?.cancel().catch(() => {});
        if (!id?.success) return { state: "uncertain" };
        await journal.record(ctx, id.data);
        signal.throwIfAborted();
        const receipt = await readPost(account, id.data, signal, payload.caption);
        return { state: "published", receipt };
      } catch { return { state: "uncertain" }; }
    },
    async reconcile(account, requestId, payload, signal) {
      try {
        validatePayload(account, payload);
        const id = await journal.candidate(context(account, payload, requestId));
        if (!id) return null; // Never guess from caption matching or resend the post.
        await authorize(account, signal);
        return await readPost(account, id, signal, payload.caption);
      } catch { return null; }
    },
    async metrics(account, externalPostId, signal, rawSubject) {
      try {
        const subject = metricSubject.parse(rawSubject);
        validatePayload(account, subject.payload); postId.parse(externalPostId);
        if (subject.publishedAt.getTime() <= 0 || subject.publishedAt > new Date()) throw failure();
        await authorize(account, signal); await readPost(account, externalPostId, signal, undefined, subject);
        const kind = externalPostId.startsWith("urn:li:ugcPost:") ? "ugcPost" : "share";
        const query = new URLSearchParams({ q: "organizationalEntity", organizationalEntity: account.externalAccountId });
        // Preserve documented Rest.li list delimiters while encoding the validated URN.
        const filter = kind === "share" ? `shares=List(${encodeURIComponent(externalPostId)})` : `ugcPosts[0]=${encodeURIComponent(externalPostId)}`;
        const result = z.object({ elements: z.array(z.object({ organizationalEntity: z.literal(account.externalAccountId), share: postId.optional(), ugcPost: postId.optional(), totalShareStatistics: z.object({ impressionCount: count.optional(), uniqueImpressionsCount: count.optional(), clickCount: count.optional(), likeCount: likes.optional(), commentCount: count.optional(), shareCount: count.optional() }) })).max(1) }).parse(await get(account, `organizationalEntityShareStatistics?${query}&${filter}`, signal));
        const row = result.elements[0];
        if (row && (row[kind] !== externalPostId || (kind === "share" ? row.ugcPost : row.share))) throw failure();
        const s = row?.totalShareStatistics;
        // Negative organic likes can be valid platform adjustments. Do not clamp them to zero
        // or let incomplete/negative components create a positive engagement-learning signal.
        const components = [s?.likeCount, s?.commentCount, s?.shareCount];
        const engagements = components.every(n => n !== undefined && n >= 0) ? components.reduce<number>((sum, n) => sum + n!, 0) : null;
        // Detect edits during the statistics request as well as edits preceding it.
        await readPost(account, externalPostId, signal, undefined, subject);
        signal.throwIfAborted(); createLinkedInOAuthAdapter(config);
        return metricReading.parse({ observedAt: new Date(), definitionVersion: `linkedin-organic-post-likes-comments-shares-${config.apiVersion}-v2`, impressions: s?.impressionCount ?? null, reach: s?.uniqueImpressionsCount ?? null, engagements, clicks: s?.clickCount ?? null, videoViews: null });
      } catch (error) { if (error instanceof MetricSourceChangedError) throw error; throw failure(); }
    },
  };
}
