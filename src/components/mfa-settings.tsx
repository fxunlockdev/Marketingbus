"use client";
import { useEffect, useState } from "react";
export function MfaSettings() {
  const [status, setStatus] = useState<{
      enabled: boolean;
      available: boolean;
      recoveryCodesRemaining: number;
      requiredByWorkspace: boolean;
    } | null>(null),
    [password, setPassword] = useState(""),
    [code, setCode] = useState(""),
    [secret, setSecret] = useState(""),
    [recovery, setRecovery] = useState<string[]>([]),
    [done, setDone] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void fetch("/api/mfa", { signal: abort.signal })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw Error(data.error);
        if (!abort.signal.aborted) setStatus(data);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, []);
  async function submit(action: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/mfa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          password,
          ...(action === "begin" ? {} : { code }),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      setSecret(result.secret);
      setRecovery(result.recoveryCodes);
      setDone(result.signInAgain);
      setCode("");
      if (result.signInAgain) setPassword("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to update MFA.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-busy={busy}>
      <h2>Authenticator security</h2>
      <p role="alert" className="form-error">
        {error}
      </p>
      {done ? (
        <>
          <p role="status">
            Security settings updated. All sessions were signed out.
          </p>
          {recovery.length > 0 && (
            <>
              <h3>Save these recovery codes now</h3>
              <p>
                Store these securely outside this account. Each works once and
                will not be shown again. Anyone with your password and one of
                these codes can sign in.
              </p>
              <ul>
                {recovery.map((c) => (
                  <li key={c}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          <a href="/login">Sign in again</a>
        </>
      ) : (
        <>
          <p>
            {status?.enabled
              ? `MFA enabled · ${status.recoveryCodesRemaining} recovery codes remaining`
              : "MFA not enabled"}
          </p>
          {status?.requiredByWorkspace && <p>A workspace requires MFA. You can enroll here, but cannot disable your authenticator while that membership requires it. Password recovery does not bypass this policy.</p>}
          {!status?.available && (
            <p>
              MFA setup requires the operator to configure the server encryption
              keyring.
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit(
                status?.enabled ? "disable" : secret ? "confirm" : "begin"
              );
            }}
          >
            <label>
              Current password
              <input
                type="password"
                required
                minLength={12}
                maxLength={64}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {secret && (
              <>
                <p>
                  Add a time-based account to your authenticator with this setup
                  key. Use SHA-1, 6 digits and a 30-second interval. Enrollment
                  expires in 10 minutes.
                </p>
                <p>
                  <code style={{ overflowWrap: "anywhere" }}>{secret}</code>
                </p>
                <p>Do not share this key or put it in screenshots.</p>
              </>
            )}
            {(secret || status?.enabled) && (
              <label>
                {status?.enabled
                  ? "Authenticator or recovery code"
                  : "Authenticator code"}
                <input
                  required
                  maxLength={64}
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </label>
            )}
            <button
              className="button secondary"
              disabled={busy || !status?.available || (!!status.enabled && status.requiredByWorkspace)}
            >
              {status?.enabled
                ? "Disable MFA and sign out"
                : secret
                ? "Confirm authenticator"
                : "Set up authenticator"}
            </button>
          </form>
          <p>
            Password recovery does not disable MFA. Wait for the next
            authenticator code if you just used the current one.
          </p>
        </>
      )}
    </section>
  );
}
