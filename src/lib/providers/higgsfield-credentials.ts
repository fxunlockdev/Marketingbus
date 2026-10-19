export type HiggsfieldCredentials = { keyId: string; secret: string } | { apiKey: string };
const fullKey = (value: string) => /^[\x21-\x7e]{16,1024}$/.test(value);
/** Server-only credentials. The complete copied key is opaque to the operator. */
export function higgsfieldCredentials(env: NodeJS.ProcessEnv = process.env) {
  const key = env.HIGGSFIELD_API_KEY || "", secret = env.HIGGSFIELD_API_SECRET || "";
  const candidates = [env.HF_CREDENTIALS, env.HF_API_KEY].filter((v): v is string => !!v);
  if (secret) {
    if (!/^[A-Za-z0-9_-]{8,256}$/.test(key) || !/^[\x21-\x7e]{16,512}$/.test(secret) || secret.includes(":")) throw Error("Invalid Higgsfield server credentials.");
    candidates.push(`${key}:${secret}`);
  } else if (key) candidates.push(key);
  if (!candidates.length || candidates.some(v => !fullKey(v))) throw Error("Invalid Higgsfield server credentials.");
  if (new Set(candidates).size !== 1) throw Error("Conflicting Higgsfield server credentials.");
  const complete = candidates[0], parts = complete.split(":");
  // Preserve the identity/signatures of the existing split-credential adapter.
  if (parts.length === 2 && /^[A-Za-z0-9_-]{8,256}$/.test(parts[0]) && /^[\x21-\x7e]{16,512}$/.test(parts[1])) {
    return { keyId: parts[0], secret: parts[1] } satisfies HiggsfieldCredentials;
  }
  return { apiKey: complete } satisfies HiggsfieldCredentials;
}

export function hasHiggsfieldCredentials() {
  try { higgsfieldCredentials(); return true; } catch { return false; }
}
