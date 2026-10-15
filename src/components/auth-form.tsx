"use client";
import { useState } from "react";
import { ArrowUpRight, Check } from "lucide-react";
export function AuthForm() {
  const [register, setRegister] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const values = new FormData(event.currentTarget);
    try {
      const res = await fetch(`/api/auth/${register ? "register" : "login"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: values.get("email"),
          password: values.get("password"),
          ...(!register ? { code: values.get("code") || "" } : {}),
          ...(register ? { name: values.get("name"), invitationCode: values.get("invitationCode") || "" } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw Error(data.error);
      window.location.href = "/studio";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to sign in.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-layout">
      <section className="auth-story">
        <a href="/" className="wordmark">
          <span className="brand-mark">
            <i />
          </span>
          marketingbus<span className="tiny">STUDIO</span>
        </a>
        <div>
          <span className="eyebrow">
            A little more you. A lot less busywork.
          </span>
          <h1>
            Your business.
            <br />
            <span className="muted">Its own creative team.</span>
          </h1>
          <p>
            Teach us your brand. Find your direction.
            <br />
            Make work you are proud to put your name on.
          </p>
          <div className="auth-points">
            {[
              "Your identity, remembered",
              "Your feedback, carried forward",
              "Your approval, always",
            ].map((t) => (
              <span key={t}>
                <Check size={16} />
                {t}
              </span>
            ))}
          </div>
        </div>
        <small>A private workspace for your next good idea.</small>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <span className="eyebrow">YOUR STUDIO STARTS HERE</span>
          <h2>{register ? "Make yourself at home." : "Welcome back."}</h2>
          <p>
            {register
              ? "Create an account, then introduce your business."
              : "Sign in to pick up where you left off."}
          </p>
          <form onSubmit={submit} aria-busy={busy}>
            {register && (
              <label>
                Your name
                <input
                  name="name"
                  required
                  minLength={2}
                  maxLength={80}
                  autoComplete="name"
                />
              </label>
            )}
            <label>
              Email address
              <input
                name="email"
                type="email"
                required
                maxLength={254}
                autoComplete="email"
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                required
                minLength={12}
                maxLength={64}
                autoComplete={register ? "new-password" : "current-password"}
                aria-describedby="password-help"
              />
            </label>
            <small id="password-help">
              At least 12 characters. Use a unique password.
            </small>
            {register && <label>Invitation code
              <input name="invitationCode" type="password" maxLength={128} autoComplete="off" aria-describedby="invitation-help" />
              <small id="invitation-help">Required for the hosted private pilot. Local development can leave this blank.</small>
            </label>}
            {!register && <label>Authenticator or recovery code (if enabled)<input name="code" autoComplete="one-time-code" maxLength={64} /></label>}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="button dark wide" disabled={busy}>
              {busy
                ? "One moment…"
                : register
                  ? "Create my account"
                  : "Sign in"}
              <ArrowUpRight size={17} />
            </button>
          </form>
          <button
            className="text-button"
            onClick={() => {
              setRegister(!register);
              setError("");
            }}
          >
            {register
              ? "Already have an account? Sign in"
              : "New here? Create an account"}
          </button>
          <p><a href="/recover">Forgot your password?</a></p>
          <div className="notice subtle">
            Private pilot · AI generation requires configured providers and credits. Social publishing is not activated yet.
            No payment is collected.
          </div>
        </div>
      </section>
    </main>
  );
}
