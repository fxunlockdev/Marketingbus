"use client";
import { useEffect, useRef, useState } from "react";
import type { AccountSnapshot } from "@/lib/social/account-data-contracts";
type Account = { id: string; label: string; status: string; expiresAt: string | null; dataFetchedAt: string | null; dataAttemptedAt: string | null; dataLeaseUntil: string | null; dataErrorCode: string | null };
export function SocialAccountData({ businessId, account, canManage, enabled, onChanged }: { businessId: string; account: Account; canManage: boolean; enabled: boolean; onChanged: () => Promise<void> }) {
  const [snapshot, setSnapshot] = useState<AccountSnapshot | null>(null), [opened, setOpened] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState(""), [confirm, setConfirm] = useState(false);
  const removeButton = useRef<HTMLButtonElement>(null), restoreFocus = useRef(false);
  useEffect(() => { if (!confirm && restoreFocus.current) { restoreFocus.current = false; removeButton.current?.focus(); } }, [confirm]);
  const endpoint = `/api/businesses/${businessId}/connections/data`;
  async function show() {
    const response = await fetch(`${endpoint}?connectionId=${encodeURIComponent(account.id)}`, { cache: "no-store" }), result = await response.json();
    if (!response.ok) throw Error(result.error || "Saved account data could not be loaded.");
    setSnapshot(result.snapshot); setOpened(true);
  }
  async function run(action: "view" | "refresh" | "forget") {
    setBusy(true); setError(""); setMessage("");
    try {
      if (action !== "view") {
        const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, connectionId: account.id }) }), result = await response.json();
        if (!response.ok) throw Error(result.error || "Account data could not be updated.");
        if (action === "forget") { restoreFocus.current = true; setConfirm(false); }
        await onChanged();
      }
      await show();
      setMessage(action === "forget" ? "Saved data removed. Remote posts and the connection are unchanged." : action === "refresh" ? "Verified account data refreshed. Nothing was published." : "Saved account data loaded.");
    } catch (reason) {
      setSnapshot(null); setOpened(false); setError(reason instanceof Error ? reason.message : "Please try again.");
      // A failed refresh may have invalidated the server-side snapshot.
      if (action === "refresh") await onChanged().catch(() => {});
    } finally { setBusy(false); }
  }
  const valid = account.status === "CONNECTED" && !!account.expiresAt && new Date(account.expiresAt) > new Date();
  const cooldown = !!account.dataAttemptedAt && Date.parse(account.dataAttemptedAt) > Date.now() - 15 * 60000;
  const n = (value: number | null) => value === null ? "Not available" : value.toLocaleString();
  return <div aria-label={`Data for ${account.label}`} aria-busy={busy}>
    <p className="muted">{account.dataFetchedAt ? `Last saved snapshot: ${new Date(account.dataFetchedAt).toLocaleString()}.` : "No saved account data."} Snapshots expire after 30 days; background removal and backup retention follow separate policies.</p>
    {account.dataErrorCode && <p>Last refresh was not completed. Check platform access before retrying.</p>}
    <div className="tag-row">
      <button className="button secondary" disabled={busy} aria-label={`View saved data for ${account.label}`} onClick={() => run("view")}>View saved data</button>
      <button className="button secondary" disabled={busy || !canManage || !enabled || !valid || cooldown} aria-label={`Refresh data for ${account.label}`} onClick={() => run("refresh")}>Refresh data</button>
      <button ref={removeButton} className="button secondary" disabled={busy || !canManage} aria-label={`Remove saved data for ${account.label}`} onClick={() => setConfirm(true)}>Remove saved data</button>
    </div>
    <p className="muted">{!canManage ? "An owner or admin must refresh or remove saved data." : !enabled ? "Platform data setup is pending." : !valid ? "Reconnect this account to refresh its data." : cooldown ? "Refresh is limited to once every 15 minutes. Use Refresh connections to update availability." : "Refresh reads the selected account only. It does not publish, spend AI credits or train agents."}</p>
    {confirm && <fieldset><legend>Remove the saved snapshot for {account.label}?</legend><p>This removes the current saved data, not remote posts or account authorization. Retained backups follow the backup policy.</p><button className="button secondary" disabled={busy} onClick={() => { restoreFocus.current = true; setConfirm(false); }}>Keep saved data</button><button className="button" disabled={busy} onClick={() => run("forget")}>Confirm removal</button></fieldset>}
    <p role="status">{busy ? "Checking account data…" : message}</p>
    {error && <p role="alert">{error}</p>}
    {opened && (snapshot ? <section className="panel" aria-label={`Saved data for ${account.label}`}>
      <h3>{snapshot.profile.name}</h3>
      <p>Observed {new Date(snapshot.observedAt).toLocaleString()}. This is a saved snapshot, not live reporting.</p>
      <dl><dt>Followers</dt><dd>{n(snapshot.profile.followers)}</dd><dt>Page likes</dt><dd>{n(snapshot.profile.likes)}</dd><dt>Media count</dt><dd>{n(snapshot.profile.mediaCount)}</dd></dl>
      {snapshot.lifetimeOrganic.available ? <><h4>Lifetime organic company statistics</h4><p>These are company totals, not totals for the posts below. They are not conversion or paid-ad attribution.</p><dl><dt>Impressions</dt><dd>{n(snapshot.lifetimeOrganic.impressions)}</dd><dt>Unique impressions</dt><dd>{n(snapshot.lifetimeOrganic.uniqueImpressions)}</dd><dt>Clicks</dt><dd>{n(snapshot.lifetimeOrganic.clicks)}</dd><dt>Likes</dt><dd>{n(snapshot.lifetimeOrganic.likes)}</dd><dt>Comments</dt><dd>{n(snapshot.lifetimeOrganic.comments)}</dd><dt>Shares</dt><dd>{n(snapshot.lifetimeOrganic.shares)}</dd></dl></> : <p>Account-level impression, reach and conversion insights are not available in this snapshot.</p>}
      <h4>Recent published posts</h4><p>Up to 20 posts from one bounded provider response—not a complete archive. Imported posts are not proof that Marketingbus published them and do not automatically enter learning.</p>
      {!snapshot.posts.length ? <p>No posts returned by the provider.</p> : <ul>{snapshot.posts.map(post => <li key={post.externalId} style={{ overflowWrap: "anywhere" }}><p>{post.text || "No text supplied."}{post.textTruncated && " (Excerpt truncated.)"}</p><p>{new Date(post.publishedAt).toLocaleString()} · {post.format}{post.sponsored === true ? " · Sponsored" : ""}</p><p>Likes: {n(post.likes)} · Comments: {n(post.comments)}</p>{post.permalink && <a href={post.permalink} target="_blank" rel="noopener noreferrer">View post on {snapshot.provider}</a>}</li>)}</ul>}
      {snapshot.hasMore && <p>More posts exist on the platform; this snapshot does not include them.</p>}
    </section> : <p>No current saved snapshot is available. It may not have been fetched, may have expired, or account access may need renewal.</p>)}
  </div>;
}
