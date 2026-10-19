"use client";
import { useEffect, useRef, useState } from "react";
import { CreativeProcedures } from "./creative-procedures";
type Skill = { id: string; instruction: string; status: string; valid: boolean; channel: string; examples: number };
export function LearnedSkills({ businessId }: { businessId: string }) {
  const [data, setData] = useState<{ canEdit: boolean; skills: Skill[] } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const alert = useRef<HTMLParagraphElement>(null);
  async function load() {
    const response = await fetch(`/api/businesses/${businessId}/learning`, { cache: "no-store" });
    if (!response.ok) throw Error("Could not load learned skills. Try again.");
    setData(await response.json());
  }
  useEffect(() => { let current = true; fetch(`/api/businesses/${businessId}/learning`, { cache: "no-store" }).then(async r => { if (!r.ok) throw Error(); const body = await r.json(); if (current) setData(body); }).catch(() => { if (current) setError("Could not load learned skills. Try again."); }); return () => { current = false; }; }, [businessId]);
  async function act(action: string, proposalId?: string) {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/businesses/${businessId}/learning`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...(proposalId ? { proposalId } : {}) }) });
      const result = await response.json(); if (!response.ok) throw Error(result.error || "Skill update failed.");
      await load(); setMessage(action === "reflect-skills" ? result.created ? `${result.created} new skill proposals ready for review.` : "No new qualifying corrections. Each rule needs two distinct creatives with feedback followed by an approved correction." : "Skill updated. Future copy uses the current approved rules; existing posts are unchanged.");
    } catch (e) { setError(e instanceof Error ? e.message : "Skill update failed."); setTimeout(() => alert.current?.focus(), 0); }
    finally { setBusy(false); }
  }
  return <><section className="panel" aria-labelledby="learned-skills-heading" aria-busy={busy}>
    <h2 id="learned-skills-heading">Skills learned from your corrections</h2>
    <p>Review → approved correction → reusable rule → your activation → checks on future copy. Rules stay with this business and destination. No extra AI charge.</p>
    <p>Currently detects repeated requests for no hashtags, no emoji and shorter captions (80 words maximum). Two corrected, approved creatives are required. This is a checked preference—not proof of better marketing performance. Other feedback can still be saved as an explicit preference above.</p>
    {error && <p role="alert" tabIndex={-1} ref={alert}>{error}</p>}
    {message && <p role="status">{message}</p>}
    {!data && !error && <p role="status">Loading learned skills…</p>}
    {!data && error && <button className="button" disabled={busy} onClick={() => { setError(""); void load().catch(() => setError("Could not load learned skills. Try again.")); }}>Retry learned skills</button>}
    {data && <>
      {!data.canEdit && <p>Only workspace owners, administrators and editors can manage skills.</p>}
      <button className="button" disabled={busy || !data.canEdit} onClick={() => act("reflect-skills")}>Find lessons in approved corrections</button>
      {!data.skills.length && <p>No learned rules yet. Nothing is invented from missing feedback.</p>}
      {data.skills.map(skill => <article key={skill.id}>
        <h3>{skill.channel} · {skill.status === "SKILL_ACTIVE" ? skill.valid ? "Active" : "Inactive: evidence changed or expired" : skill.status === "SKILL_PROPOSED" ? "Proposed" : skill.status === "SKILL_EXPIRED" ? "Expired" : "Retired"}</h3>
        <p>{skill.instruction}</p><p>{skill.examples} distinct corrected examples. Rechecked before generation; older than 90 days or changed brand/copy/approval stops use. Original supplied skill packs are never modified.</p>
        {skill.status === "SKILL_PROPOSED" && <button className="button" disabled={busy || !data.canEdit || !skill.valid} onClick={() => act("activate-skill", skill.id)}>Activate this rule</button>}
        {skill.status !== "SKILL_RETIRED" && <button className="button" disabled={busy || !data.canEdit} onClick={() => act("retire-skill", skill.id)}>Retire this rule</button>}
        {!skill.valid && skill.status === "SKILL_PROPOSED" && <p>Activation is unavailable because supporting examples changed or expired.</p>}
      </article>)}
    </>}
  </section><CreativeProcedures key={businessId} businessId={businessId} /></>;
}
