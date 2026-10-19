"use client";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Globe, Palette, ShieldCheck } from "lucide-react";
import { brandInput, type BrandInput } from "@/lib/brand";
import { contentPreferences, strategies } from "@/lib/onboarding/preferences";
import { KnowledgeLibrary } from "./knowledge-library";
import { AssetLibrary } from "./asset-library";
import { presets } from "./brand-form";

const empty: BrandInput = { name: "", website: "", industry: "", offering: "", audience: "", goal: "", difference: "", proof: "", tone: "Clear and conversational", restrictions: "", color: "#c67139", designPreset: "editorial", channels: ["Instagram", "LinkedIn"], contentPreferences: contentPreferences.parse({}) };
type Setup = { profile: BrandInput; step: number; revision: number; version: number; canEdit: boolean };
const steps = ["Welcome", "Sources", "Business", "Strategy", "Look & assets", "Review"];
export function BusinessSetup({ businessId, workspaces, onComplete, onChange }: {
  businessId?: string; workspaces: { id: string; name: string }[]; onComplete: (id: string) => void; onChange: () => void;
}) {
  const uid = useId(), heading = useRef<HTMLHeadingElement>(null), requestId = useRef("");
  const [id, setId] = useState(businessId), [saved, setSaved] = useState<Setup | null>(null), [step, setStep] = useState(businessId ? 1 : 0);
  const [profile, setProfile] = useState<BrandInput>(empty), [organizationId, setOrganizationId] = useState(workspaces[0]?.id ?? "");
  const [busy, setBusy] = useState(!!businessId), [error, setError] = useState(""), [confirmed, setConfirmed] = useState(false);
  const preferences = contentPreferences.parse(profile.contentPreferences ?? {});
  async function load(target: string, signal?: AbortSignal) {
    const response = await fetch(`/api/businesses/${target}/onboarding`, { signal }); const data = await response.json();
    if (!response.ok) throw Error(data.error || "Could not load setup.");
    if (!signal?.aborted) { setSaved(data); setProfile(data.profile); setStep(Math.min(data.step, 5)); setConfirmed(false); }
  }
  useEffect(() => {
    if (!businessId) return;
    const controller = new AbortController();
    void load(businessId, controller.signal).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [businessId]);
  useEffect(() => { heading.current?.focus(); }, [step]);
  const set = (key: keyof BrandInput, value: unknown) => { setProfile(old => ({ ...old, [key]: value })); setConfirmed(false); };
  function field(key: "name" | "website" | "industry" | "offering" | "audience" | "goal" | "difference" | "proof" | "tone" | "restrictions", label: string, hint: string, required = false, area = false) {
    const limits = { name: 100, website: 500, industry: 100, offering: 2500, audience: 1500, goal: 1000, difference: 1500, proof: 2000, tone: 300, restrictions: 2000 };
    const props = { id: `${uid}-${key}`, value: profile[key], required, maxLength: limits[key], placeholder: hint, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(key, e.target.value), "aria-describedby": `${uid}-error` };
    return <label htmlFor={props.id}>{label}{area ? <textarea {...props} rows={3} /> : <input {...props} type={key === "website" ? "url" : "text"} />}</label>;
  }
  async function request(url: string, body: unknown) {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw Error(data.error || "Could not save setup."); return data;
  }
  async function advance() {
    setBusy(true); setError("");
    try {
      if (!id) {
        requestId.current ||= crypto.randomUUID();
        const data = await request("/api/onboarding", { organizationId, requestId: requestId.current, name: profile.name, website: profile.website, industry: profile.industry });
        setId(data.id); await load(data.id); onChange(); return;
      }
      if (!saved) throw Error("Reload the saved setup before continuing.");
      if (step >= 2) {
        const valid = brandInput.safeParse(profile);
        if (!valid.success) throw Error(valid.error.issues[0].message);
      }
      await request(`/api/businesses/${id}/onboarding`, step === 5
        ? { action: "finish", revision: saved.revision, version: saved.version, confirmed }
        : { action: "save", revision: saved.revision, version: saved.version, step: step + 1, profile });
      if (step === 5) { onComplete(id); return; }
      await load(id); onChange();
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save."); }
    finally { setBusy(false); }
  }
  const canEdit = !id || !!saved?.canEdit;
  return <section className="setup-flow" aria-busy={busy} aria-label="Guided business setup">
    <nav aria-label="Setup progress"><ol className="setup-progress">{steps.map((name, index) => <li key={name} aria-current={index === step ? "step" : undefined}><span>{index < step ? <Check size={13} aria-hidden="true" /> : index + 1}</span>{name}</li>)}</ol></nav>
    <div className="setup-heading"><span className="eyebrow">YOUR BUSINESS. YOUR CREATIVE DIRECTION.</span><h1 ref={heading} tabIndex={-1}>{["Let’s build around your business.", "Give your team the real story.", "Make sure we understand you.", "Choose a direction worth following.", "Make it unmistakably yours.", "Your foundation is ready to review."][step]}</h1><p>{["Start with your website, or tell us about your business yourself.", "Import your website or documents, then review source-backed suggestions. Nothing becomes an approved fact automatically.", "Confirm the offering, audience and facts that every creative will use.", "Set the purpose, writing language and destinations for your first planning outline.", "Choose a visual starting point and add originals you have permission to use.", "Confirm your brand to create a planning outline. No credits are spent and nothing is published."][step]}</p></div>
    <p id={`${uid}-error`} role={error ? "alert" : undefined} className="error">{error}</p>
    {id && <div className="setup-save-state"><span>Last completed step saved · current edits save when you continue</span><button type="button" className="text-button" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await load(id); } catch (e) { setError(e instanceof Error ? e.message : "Reload failed."); } finally { setBusy(false); } }}>Reload saved setup</button><small>Reload discards unsaved changes on this step.</small></div>}
    {id && !saved ? <p role="status">{busy ? "Loading saved setup…" : "Setup could not be loaded. Use Reload saved setup to try again."}</p> : <>
    {step === 1 && id && <KnowledgeLibrary businessId={id} initialUrl={profile.website} />}
    {step === 4 && id && <div className="setup-assets"><details><summary>Upload and approve logos, product photos and references</summary><AssetLibrary businessId={id} /></details></div>}
    <form className="form-card setup-card" onSubmit={e => { e.preventDefault(); void advance(); }}>
      <fieldset disabled={busy || !canEdit} className="setup-fields">
      {step === 0 && <div className="setup-split"><div><div className="section-title"><Globe size={20} aria-hidden="true" /><h2>The essentials</h2></div>
        <label>Workspace<select required value={organizationId} onChange={e => setOrganizationId(e.target.value)}>{workspaces.map(w => <option value={w.id} key={w.id}>{w.name}</option>)}</select></label>
        {field("name", "Business name", "Your business", true)}{field("website", "Business website (optional)", "https://yourbusiness.com")}{field("industry", "Industry", "e.g. Architecture or skincare")}
      </div><aside className="setup-note"><ShieldCheck size={25} aria-hidden="true" /><h2>One brief. Every creative.</h2><p>Your confirmed brand will guide copy, images and video in one Asset studio.</p><p>Adding a website saves the address. The next step asks for import permission; it does not start a crawl or spend credits here.</p><p>No website? Continue with your own description and documents.</p></aside></div>}
      {step === 1 && <div className="notice subtle">Imports and AI analysis are optional. You can write the profile manually on the next step. Website import needs an enabled scraper; AI analysis requires a separate quote and credit authorization. If you apply suggestions above, reload the saved setup before continuing.</div>}
      {step === 2 && <><div className="form-grid">{field("name", "Business name", "Your business", true)}{field("industry", "Industry", "Your category")}</div>{field("offering", "What do you offer?", "Describe your actual products or services.", true, true)}{field("audience", "Who is it for?", "Who buys and what are they trying to achieve?", true, true)}{field("goal", "What should your marketing achieve?", "e.g. Book consultations", true, true)}{field("difference", "Why do customers choose you?", "A specific, supportable difference.", false, true)}{field("proof", "What evidence can we use?", "Approved facts and their sources. Leave unknown details blank.", false, true)}{field("tone", "How should your brand sound?", "Warm, practical and clear", true)}{field("restrictions", "What should we avoid?", "Claims, topics, visual styles or words to avoid.", false, true)}</>}
      {step === 3 && <><div className="form-grid"><label>Business type<select value={preferences.businessType} onChange={e => set("contentPreferences", { ...preferences, businessType: e.target.value })}><option value="services">Services</option><option value="local">Local business</option><option value="products">Products</option></select></label><label>Writing language<select value={preferences.language} onChange={e => set("contentPreferences", { ...preferences, language: e.target.value })}><option>English (US)</option><option>English (UK)</option></select></label></div><fieldset><legend>Content strategy</legend><div className="setup-options">{strategies.map(s => <label key={s.id} className={`setup-option ${preferences.strategy === s.id ? "selected" : ""}`}><input type="radio" name={`${uid}-strategy`} checked={preferences.strategy === s.id} onChange={() => set("contentPreferences", { ...preferences, strategy: s.id })} /><span><strong>{s.name}</strong><small>{s.description}</small></span></label>)}</div></fieldset><fieldset><legend>Publishing destinations</legend><p className="muted">Choose where to prepare content. These choices do not connect accounts or authorize posts.</p><div className="channel-options">{["Instagram", "Facebook", "LinkedIn"].map(ch => <label key={ch}><input type="checkbox" checked={profile.channels.includes(ch as never)} onChange={e => set("channels", e.target.checked ? [...profile.channels, ch] : profile.channels.filter(c => c !== ch))} />{ch}</label>)}</div><p className="small muted">X and YouTube are not offered in guided setup until their publishing integrations are available.</p></fieldset></>}
      {step === 4 && <><div className="section-title"><Palette size={20} aria-hidden="true" /><h2>Your design direction</h2></div><div className="form-grid"><label>Brand accent<input type="color" value={profile.color} onChange={e => set("color", e.target.value)} /></label><label>Image direction<select value={preferences.visualStyle} onChange={e => set("contentPreferences", { ...preferences, visualStyle: e.target.value })}><option value="natural">Natural light, everyday context</option><option value="studio">Clean studio, controlled lighting</option><option value="cinematic">Cinematic light, considered contrast</option></select></label></div><fieldset><legend>Layout preset</legend><div className="preset-grid">{presets.map(p => <label className={`preset-option ${profile.designPreset === p.id ? "selected" : ""}`} key={p.id}><input type="radio" name={`${uid}-preset`} checked={profile.designPreset === p.id} onChange={() => set("designPreset", p.id)} /><div className={`design-preview ${p.id}`} style={{ "--brand-accent": profile.color } as React.CSSProperties}><small>{profile.name}</small><strong>Your story.<br />Your point of view.</strong><span>Layout preview · not generated content</span></div><div className="preset-description"><b>{p.name}</b><p>{p.description}</p></div></label>)}</div></fieldset><p className="small muted">Original logos and products are composited without redrawing. Generated supporting artwork is reviewed separately. Bundled Figtree typography is currently supported; custom fonts and transformation-strength controls are not offered here.</p></>}
      {step === 5 && <><div className="setup-summary"><section><h2>{profile.name}</h2><p>{profile.offering}</p><dl><dt>Audience</dt><dd>{profile.audience}</dd><dt>Goal</dt><dd>{profile.goal}</dd><dt>Voice</dt><dd>{profile.tone}</dd><dt>Proof</dt><dd>{profile.proof || "No approved proof supplied. Do not invent claims."}</dd><dt>Restrictions</dt><dd>{profile.restrictions || "None supplied"}</dd></dl></section><aside className="setup-note"><h2>Your first direction</h2><p>{strategies.find(s => s.id === preferences.strategy)?.name}</p><p>{profile.channels.join(" · ")}</p><p>{preferences.language} · {profile.designPreset} · {preferences.visualStyle}</p><strong>0 credits to save this outline</strong><p>This is a planning outline, not generated creatives or a scheduled week. Production quotes, exact-content approvals and social connections come next.</p></aside></div><label className="checkbox-label"><input type="checkbox" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I have reviewed this business profile and approve it as the basis for content.</label></>}
      <div className="form-actions">{step > 1 ? <button type="button" className="button secondary" onClick={() => { setStep(step - 1); setConfirmed(false); }}><ArrowLeft size={16} aria-hidden="true" />Back</button> : <span />}<button className="button dark" disabled={busy || !canEdit || step === 0 && !organizationId || step === 5 && !confirmed}>{busy ? "Saving…" : step === 0 ? "Start business setup" : step === 1 ? "Continue to business details" : step === 5 ? "Confirm brand & open content plan" : "Save & continue"}<ArrowRight size={16} aria-hidden="true" /></button></div>
      </fieldset>
    </form></>}
  </section>;
}
