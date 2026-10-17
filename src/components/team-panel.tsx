"use client";
import { useEffect, useState } from "react";
import { WorkspaceSecurity } from "./workspace-security";
type Team = {
  role: string;
  requireMfa: boolean;
  members: {
    userId: string;
    role: string;
    user: { name: string; email: string };
  }[];
  invitations: {
    id: string;
    email: string;
    role: string;
    status: string;
    expiresAt: string;
  }[];
  events: { id: string; action: string; detail: string }[];
};
export function TeamPanel({ organizationId }: { organizationId: string }) {
  const [team, setTeam] = useState<Team | null>(null),
    [email, setEmail] = useState(""),
    [role, setRole] = useState("EDITOR"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void fetch(`/api/workspaces/${organizationId}/team`, {
      signal: abort.signal,
    })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw Error(data.error);
        if (!abort.signal.aborted) setTeam(data);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [organizationId, refresh]);
  async function act(input: unknown) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const r = await fetch(`/api/workspaces/${organizationId}/team`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const result = await r.json();
      if (!r.ok) throw Error(result.error);
      setMessage(
        "Workspace updated. An invitation is queued only when email delivery is configured."
      );
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to update workspace.");
    } finally {
      setBusy(false);
    }
  }
  const canManage = team && ["OWNER", "ADMIN"].includes(team.role);
  return (
    <div className="production-list" aria-busy={busy}>
      <p role="alert" className="form-error">
        {error}
      </p>
      <p role="status">{message}</p>
      {team && <WorkspaceSecurity organizationId={organizationId} required={team.requireMfa} canManage={team.role === "OWNER"} onSaved={() => setRefresh(n => n + 1)} />}
      <section className="panel">
        <h2>Workspace team</h2>
        <p>
          Membership applies to all businesses in this workspace. Owners manage
          administrators; editors can change content; viewers have read-only
          access.
        </p>
        {team?.members.map((member) => (
          <article key={member.userId} className="memory-card">
            <h3>{member.user.name}</h3>
            <p>
              {member.user.email} · {member.role}
            </p>
            {canManage && (
              <div className="tag-row">
                <label>
                  Role for {member.user.name}
                  <select
                    value={member.role}
                    disabled={
                      busy ||
                      (team.role !== "OWNER" &&
                        ["OWNER", "ADMIN"].includes(member.role))
                    }
                    onChange={(e) => {
                      if (
                        window.confirm(
                          `Change ${member.user.name}'s role to ${e.target.value}?`
                        )
                      )
                        void act({
                          action: "role",
                          userId: member.userId,
                          role: e.target.value,
                        });
                    }}
                  >
                    {(team.role === "OWNER"
                      ? ["OWNER", "ADMIN", "EDITOR", "VIEWER"]
                      : [member.role, "EDITOR", "VIEWER"]
                    )
                      .filter((r, i, a) => a.indexOf(r) === i)
                      .map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                  </select>
                </label>
                <button
                  className="button"
                  disabled={
                    busy ||
                    (team.role !== "OWNER" &&
                      ["OWNER", "ADMIN"].includes(member.role))
                  }
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove ${member.user.name} from this workspace?`
                      )
                    )
                      void act({ action: "remove", userId: member.userId });
                  }}
                >
                  Remove {member.user.name}
                </button>
              </div>
            )}
          </article>
        ))}
      </section>
      {canManage && (
        <>
          <section className="panel">
            <h2>Invite a teammate</h2>
            <p>
              Invitations expire after 24 hours. New teammates can create an account
              directly from the emailed invitation; existing accounts sign in and
              verify their email before accepting. Delivery needs the configured Resend sender.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act({ action: "invite", email, role });
              }}
            >
              <label htmlFor="team-email">Email address</label>
              <input
                id="team-email"
                type="email"
                required
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <label htmlFor="team-role">Access level</label>
              <select
                id="team-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                <option value="VIEWER">Viewer</option>
                <option value="EDITOR">Editor</option>
                {team.role === "OWNER" && (
                  <option value="ADMIN">Administrator</option>
                )}
              </select>
              <button className="button dark" disabled={busy}>
                Send invitation
              </button>
            </form>
            {team.invitations.map((invite) => (
              <article key={invite.id}>
                <p>
                  {invite.email} · {invite.role} · {invite.status}
                </p>
                <p>Expires {new Date(invite.expiresAt).toLocaleString()}</p>
                {invite.status === "PENDING" && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      act({ action: "revoke", invitationId: invite.id })
                    }
                  >
                    Revoke invitation to {invite.email}
                  </button>
                )}
              </article>
            ))}
          </section>
          <section className="panel">
            <h2>Team activity</h2>
            {team.events.length ? (
              <ul>
                {team.events.map((event) => (
                  <li key={event.id}>{event.detail}</li>
                ))}
              </ul>
            ) : (
              <p>No team changes recorded.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
