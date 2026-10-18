// Code-owned provider URLs only. Never log URL/init/error: Meta's documented
// token-debug/exchange query parameters contain server-side credentials.
export class SocialReadError extends Error {
  constructor(public status: number | null = null) { super("Social provider request could not be verified."); }
}
export async function socialJson(fetcher: typeof fetch, url: string, init: RequestInit, parent: AbortSignal): Promise<unknown> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(10000)]);
  let response: Response | undefined;
  try {
    signal.throwIfAborted();
    response = await fetcher(url, { ...init, signal, redirect: "error", cache: "no-store", credentials: "omit" });
    signal.throwIfAborted();
    if (response.status !== 200) throw new SocialReadError(response.status);
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "") || !response.body) throw new SocialReadError();
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > 131072)) throw new SocialReadError();
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 131072) throw new SocialReadError();
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } catch (error) {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    throw error instanceof SocialReadError ? error : new SocialReadError();
  }
}
