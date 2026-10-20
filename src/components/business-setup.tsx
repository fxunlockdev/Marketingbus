"use client";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { brandInput, type BrandInput } from "@/lib/brand";
import { contentPreferences } from "@/lib/onboarding/preferences";
import { setupDetails, socialAddress, websiteAddress, type SetupDetails } from "@/lib/onboarding/simple";
import type { Suggestions } from "@/lib/knowledge/grounding";
import { BrandBookDownload } from "./brand-book-download";

const empty: BrandInput = { name: "", website: "", industry: "", offering: "", audience: "", goal: "Help more people discover our business", difference: "", proof: "", tone: "Clear and conversational", restrictions: "", color: "#c67139", designPreset: "editorial", channels: ["Instagram", "LinkedIn"], contentPreferences: contentPreferences.parse({}) };
type Setup = { profile: BrandInput; details: SetupDetails; step: number; revision: number; version: number; canEdit: boolean };
type Source = { id: string; title: string; sourceUrl: string; body: string; status: string; failureMessage?: string };
const steps = ["Your website", "Your brand", "Quick review"];
export function BusinessSetup({ businessId, workspaces, onComplete, onChange }: {
  businessId?: string; workspaces: { id: string; name: string }[]; onComplete: (id: string) => void; onChange: () => void;
}) {
  const uid = useId(), heading = useRef<HTMLHeadingElement>(null), requestId = useRef("");
  const [id, setId] = useState(businessId), [saved, setSaved] = useState<Setup | null>(null), [step, setStep] = useState(0);
  const [profile, setProfile] = useState<BrandInput>(empty), [details, setDetails] = useState<SetupDetails>(setupDetails.parse({}));
  const [organizationId, setOrganizationId] = useState(workspaces[0]?.id ?? "");
  const [busy, setBusy] = useState(!!businessId), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [rights, setRights] = useState(false), [confirmed, setConfirmed] = useState(false), [file, setFile] = useState<File | null>(null);
  const [sources, setSources] = useState<Source[]>([]), [sourceError, setSourceError] = useState("");
  const [autoFill, setAutoFill] = useState(true), [fillStatus, setFillStatus] = useState(""), [fillError, setFillError] = useState("");
  const [filled, setFilled] = useState<Suggestions>([]), [refreshKey, setRefreshKey] = useState(0);
  const edited = useRef(new Set<string>());
  async function load(target: string, signal?: AbortSignal) {
    const response = await fetch(`/api/businesses/${target}/onboarding`, { signal }); const data = await response.json();
    if (!response.ok) throw Error(data.error || "Could not load your saved details.");
    if (!signal?.aborted) { setSaved(data); setProfile({ ...empty, ...data.profile, goal: data.profile.goal || empty.goal }); setDetails(data.details); setStep(!data.profile.website ? 0 : data.step >= 2 ? 2 : 1); setConfirmed(false); }
    return data as Setup;
  }
  useEffect(() => {
    if (!businessId) return;
    const controller = new AbortController();
    void load(businessId, controller.signal).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [businessId]);
  useEffect(() => { heading.current?.focus(); }, [step]);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>, checks = 0;
    async function refresh() {
      try {
        const response = await fetch(`/api/businesses/${id}/sources`, { signal: controller.signal });
        if (!response.ok) throw Error();
        const data = await response.json();
        if (!controller.signal.aborted) {
          setSources(data.sources); setSourceError("");
          // Queue creation can finish just after the first read. Poll briefly even before it appears.
          if (++checks < 20 && (!data.sources.length || data.sources.some((s: Source) => ["QUEUED", "FETCHING"].includes(s.status)))) timer = setTimeout(refresh, 6000);
        }
      } catch { if (!controller.signal.aborted) setSourceError("We couldn’t check your import. Your saved details are safe."); }
    }
    void refresh(); return () => { controller.abort(); clearTimeout(timer); };
  }, [id, step, notice, refreshKey]);
  useEffect(() => {
    if (!id || step !== 2 || !saved?.canEdit || !details.autofill) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>, checks = 0;
    setFillError(""); setFillStatus("WAITING");
    async function refresh(prepare = false) {
      try {
        const response = await fetch(`/api/businesses/${id}/onboarding/autofill`, {
          method: prepare ? "POST" : "GET", signal: controller.signal,
          ...(prepare ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}),
        });
        const data = await response.json();
        if (!response.ok) throw Error(data.error || "We couldn’t prepare your details. Please try again.");
        if (controller.signal.aborted) return;
        setFillStatus(data.status);
        if (data.status === "READY") {
          const suggestions = data.suggestions as Suggestions;
          setFilled(suggestions);
          setProfile(old => {
            const next = { ...old };
            for (const item of suggestions) {
              // Existing saved facts and in-progress edits win over late results.
              const isDefault = item.field === "name" ? old.name === new URL(old.website).hostname.replace(/^www\./, "")
                : item.field === "tone" ? old.tone === empty.tone : !old[item.field];
              if (!edited.current.has(item.field) && isDefault) next[item.field] = item.value;
            }
            return next;
          });
          setConfirmed(false);
        } else if (["WAITING", "QUEUED", "RUNNING", "SUBMITTING"].includes(data.status)) {
          if (++checks < 60) timer = setTimeout(() => void refresh(data.status === "WAITING"), 4000);
          else setFillError("This is taking longer than usual. Your request is saved; reopen this page to check it.");
        } else if (data.status === "NEEDS_RECONCILIATION") {
          setFillError("We’re checking this request before trying again, so you won’t be charged twice. You can still edit your details.");
        } else if (["FAILED", "STALE", "CANCELLED"].includes(data.status)) {
          setFillError("We couldn’t finish preparing these details. Your edits are safe. You can try again or fill in what’s missing.");
        }
      } catch (e) { if (!controller.signal.aborted) setFillError(e instanceof Error ? e.message : "We couldn’t prepare your details."); }
    }
    void refresh(true);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, step, details.autofill?.requestId, saved?.canEdit, saved?.version, refreshKey]);
  const set = (key: keyof BrandInput, value: unknown) => { edited.current.add(key); setProfile(old => ({ ...old, [key]: value })); setConfirmed(false); };
  function field(key: "name" | "website" | "offering" | "audience" | "tone", label: string, hint: string, required = true, area = false) {
    const props = { id: `${uid}-${key}`, value: profile[key], required, maxLength: { name: 100, website: 500, offering: 2500, audience: 1500, tone: 300 }[key], placeholder: hint,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(key, e.target.value), "aria-describedby": `${uid}-error` };
    return <label htmlFor={props.id}>{label}{area ? <textarea {...props} rows={3} /> : <input {...props} type="text" inputMode={key === "website" ? "url" : "text"} autoCapitalize={key === "website" ? "none" : undefined} />}</label>;
  }
  async function request(url: string, body: unknown) {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw Error(data.error || "Could not save. Please try again."); return data;
  }
  async function scan(target: string, urls: string[]) {
    let failed = false;
    for (const url of urls) {
      try { await request(`/api/businesses/${target}/sources`, { action: "website", url, rightsConfirmed: true }); }
      catch (e) { failed = true; setSourceError(e instanceof Error ? e.message : "We couldn’t read this page."); }
    }
    setNotice(failed ? "Some pages couldn’t be read. You can continue and check your details yourself." : "Your pages are being read. You can keep going.");
    setRefreshKey(key => key + 1);
  }
  async function retryWebsite() {
    if (!id) return;
    setBusy(true); setError("");
    try { await scan(id, [profile.website]); }
    finally { setBusy(false); }
  }
  async function prepareAgain() {
    if (!id || !saved) return;
    setBusy(true); setError("");
    try {
      const next = { ...details, autofill: { requestId: crypto.randomUUID(), maxCredits: 20 as const } };
      await request(`/api/businesses/${id}/onboarding`, { action: "simple-save", revision: saved.revision, version: saved.version, step: 2, profile, details: next });
      await load(id); onChange();
    } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); }
    finally { setBusy(false); }
  }
  async function advance() {
    setBusy(true); setError("");
    try {
      if (step === 0) {
        const website = websiteAddress(profile.website);
        let host: string;
        try { host = new URL(website).hostname.replace(/^www\./, ""); } catch { throw Error("Enter your website, for example www.yourbusiness.com."); }
        const next = { ...profile, website, name: profile.name || host };
        let target = id;
        if (!target) {
          requestId.current ||= crypto.randomUUID();
          const data = await request("/api/onboarding", { organizationId, requestId: requestId.current, name: next.name, website, industry: "" });
          target = data.id; setId(target);
        } else {
          if (!saved) throw Error("Please reload your saved details.");
          await request(`/api/businesses/${target}/onboarding`, { action: "simple-save", revision: saved.revision, version: saved.version, step: 1, profile: next, details });
        }
        await load(target!); setRights(false); onChange(); await scan(target!, [website]); return;
      }
      if (!id || !saved) throw Error("Please reload your saved details.");
      const normalized = { ...details, socialProfiles: details.socialProfiles.filter(s => s.url.trim()).map(s => ({ ...s, url: socialAddress(s.platform, s.url) })) };
      if (step === 1) {
        if (normalized.brandBook === "undecided") throw Error("Choose whether you have a brand book.");
        if (file && normalized.brandBook === "upload") {
          if (file.size > 5 * 1024 * 1024) throw Error("Choose a file smaller than 5 MB.");
          const response = await fetch(`/api/businesses/${id}/sources/upload`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "x-document-name": file.name.replace(/[^\x20-\x7e]/g, "_"), "x-content-rights": rights ? "confirmed" : "" }, body: file });
          const result = await response.json(); if (!response.ok) throw Error(result.error || "We couldn’t read this file.");
        }
        const nextDetails = { ...normalized, autofill: autoFill ? normalized.autofill ?? { requestId: crypto.randomUUID(), maxCredits: 20 as const } : undefined };
        await request(`/api/businesses/${id}/onboarding`, { action: "simple-save", revision: saved.revision, version: saved.version, step: 2, profile, details: nextDetails });
        setFile(null); await load(id); onChange();
        if (normalized.socialProfiles.length) await scan(id, normalized.socialProfiles.map(s => s.url));
        return;
      }
      const valid = brandInput.safeParse(profile); if (!valid.success) throw Error(valid.error.issues[0].message);
      if (!confirmed) throw Error("Check your details before finishing.");
      await request(`/api/businesses/${id}/onboarding`, { action: "simple-save", revision: saved.revision, version: saved.version, step: 5, profile: valid.data, details: normalized });
      const current = await load(id);
      await request(`/api/businesses/${id}/onboarding`, { action: "finish", revision: current.revision, version: current.version, confirmed: true });
      onComplete(id);
    } catch (e) { setError(e instanceof Error ? e.message : "Please check your details and try again."); }
    finally { setBusy(false); }
  }
  const canEdit = !id || !!saved?.canEdit;
  const ready = sources.filter(s => s.status === "PROPOSED");
  const pending = sources.some(s => ["QUEUED", "FETCHING"].includes(s.status));
  const preparing = ["WAITING", "QUEUED", "RUNNING", "SUBMITTING"].includes(fillStatus) && !fillError;
  return <section className="setup-flow simple-setup" aria-busy={busy} aria-label="Guided business setup">
    <nav aria-label="Setup progress"><ol className="setup-progress">{steps.map((name, index) => <li key={name} aria-current={index === step ? "step" : undefined}><span>{index < step ? <Check size={13} aria-hidden="true" /> : index + 1}</span>{name}</li>)}</ol></nav>
    <div className="setup-heading"><h1 ref={heading} tabIndex={-1}>{["Let’s start with your website.", "A little more about your brand.", "Does this sound like you?"][step]}</h1><p>{["We’ll look at your website to help get your brand ready.", "Add what you have. We’ll help with the rest.", preparing || pending ? "We’re preparing your details. You can edit anything while we work." : filled.length ? "We’ve filled in what we found. Check it and change anything you like." : "Check your details below. You can read your website again if anything is missing."][step]}</p></div>
    <p id={`${uid}-error`} role={error ? "alert" : undefined} className="error">{error}</p>
    {id && !saved ? <p role="status">{busy ? "Loading your details…" : "We couldn’t load your details. Please refresh this page."}</p> : <form className="form-card setup-card" onSubmit={e => { e.preventDefault(); void advance(); }}>
      <fieldset disabled={busy || !canEdit} className="setup-fields">
        {step === 0 && <>
          {workspaces.length > 1 && !id && <label>Workspace<select value={organizationId} onChange={e => setOrganizationId(e.target.value)}>{workspaces.map(w => <option value={w.id} key={w.id}>{w.name}</option>)}</select></label>}
          {field("website", "Your website", "www.yourbusiness.com")}
          <label className="checkbox-label"><input type="checkbox" required checked={rights} onChange={e => setRights(e.target.checked)} />This is my business, and I have permission to read its website.</label>
        </>}
        {step === 1 && <>
          <details className="setup-socials"><summary>Add your social profiles <span className="muted">(optional)</span></summary>
            <p className="small muted">We’ll try to read public pages. This won’t connect your accounts or post anything.</p>
            {(["Instagram", "Facebook", "LinkedIn"] as const).map(platform => <label key={platform}>{platform}<input type="text" autoCapitalize="none" maxLength={500} placeholder={platform === "LinkedIn" ? "Company page link or handle" : "@yourbusiness or profile link"} value={details.socialProfiles.find(s => s.platform === platform)?.url ?? ""} onChange={e => setDetails(old => ({ ...old, socialProfiles: [...old.socialProfiles.filter(s => s.platform !== platform), { platform, url: e.target.value }] }))} aria-describedby={`${uid}-error`} /></label>)}
          </details>
          <fieldset className="setup-choice"><legend>Do you have a brand book?</legend><p className="small muted">A guide to your logo, colours or writing style.</p>
            <div className="channel-options">{[["upload", "Yes"], ["create", "No, help me make one"], ["skip", "Not now"]].map(([value, label]) => <label key={value}><input type="radio" name={`${uid}-book`} required checked={details.brandBook === value} onChange={() => setDetails(old => ({ ...old, brandBook: value as SetupDetails["brandBook"] }))} />{label}</label>)}</div>
          </fieldset>
          {details.brandBook === "upload" && <><label>Drop your brand book here, or choose a file<input type="file" accept=".pdf,.docx,.pptx,.txt,.md" onChange={e => setFile(e.target.files?.[0] ?? null)} aria-describedby={`${uid}-file-help ${uid}-error`} /></label><p id={`${uid}-file-help`} className="small muted">PDF, Word, PowerPoint or text · up to 5 MB. Text is read; logos and images aren’t imported. You can also add it later.</p></>}
          {details.brandBook === "create" && <p className="small muted">We’ll make a simple starter guide from the details you review next. You can change it later.</p>}
          {(file && details.brandBook === "upload" || details.socialProfiles.some(s => s.url.trim())) && <label className="checkbox-label"><input type="checkbox" required checked={rights} onChange={e => setRights(e.target.checked)} />I have permission to use these files and public profiles.</label>}
          <label className="checkbox-label"><input type="checkbox" checked={autoFill} onChange={e => setAutoFill(e.target.checked)} />Fill in my details from my website and brand book.</label>
          {autoFill && <p className="small muted">Review my brand uses up to 20 credits. You’ll check the details before saving.</p>}
        </>}
        {step === 2 && <>
          <div role="status">
            {preparing && <p>Preparing your details…</p>}
            {fillError && <p>{fillError}</p>}
            {fillStatus === "READY" && !filled.some(s => s.field === "audience") && <p>We couldn’t find who your customers are. Please add that below.</p>}
            {fillStatus === "READY" && !filled.some(s => s.field === "offering") && <p>We couldn’t find a clear description of your services. Please add one below.</p>}
          </div>
          {!preparing && fillStatus !== "NEEDS_RECONCILIATION" && (fillStatus !== "READY" || !profile.offering || !profile.audience) && ready.length > 0 && <button type="button" className="button secondary" onClick={() => void prepareAgain()}>Fill in my details · up to 20 credits</button>}
          {field("name", "Business name", "Your business")}
          {field("offering", "What do you do?", "A short description of your products or services.", true, true)}
          {field("audience", "Who is it for?", "For example, local families or small business owners.")}
          {filled.some(s => s.kind === "SUMMARY_DRAFT" || s.kind === "INFERRED_AUDIENCE") && <p className="small muted">We’ve drafted these details from your website. The suggested audience is our interpretation—change anything that doesn’t fit.</p>}
          <label>Your main goal<select value={profile.goal} onChange={e => set("goal", e.target.value)}>{[...new Set([profile.goal, "Help more people discover our business", "Get more enquiries", "Sell more products", "Keep our customers engaged"])].map(goal => <option key={goal}>{goal}</option>)}</select></label>
          <details><summary>Colours, voice and channels <span className="muted">(optional)</span></summary><div className="setup-extras">
            {field("tone", "How should you sound?", "Clear and conversational")}
            <label>Brand colour<input type="color" value={profile.color} onChange={e => set("color", e.target.value)} /></label>
            <fieldset><legend>Where would you like content?</legend><div className="channel-options">{(["Instagram", "Facebook", "LinkedIn"] as const).map(ch => <label key={ch}><input type="checkbox" checked={profile.channels.includes(ch)} onChange={e => set("channels", e.target.checked ? [...profile.channels, ch] : profile.channels.filter(c => c !== ch))} />{ch}</label>)}</div></fieldset>
          </div></details>
          {details.brandBook === "create" && brandInput.safeParse(profile).success && <div><BrandBookDownload profile={profile} draft /><p className="small muted">A starter guide using these details and your brand colour. Open it in a browser to save as PDF.</p></div>}
          <label className="checkbox-label"><input type="checkbox" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />These details are correct.</label>
        </>}
        {step > 0 && <div className="setup-import-status"><p role="status">{sourceError || (pending ? "Reading your pages…" : ready.length ? "Your website or documents are ready." : notice || "Your website hasn’t been read yet.")}</p>
          {!pending && !sources.some(s => s.sourceUrl === profile.website && s.status === "PROPOSED") && <button type="button" className="button secondary" onClick={() => void retryWebsite()}>Read my website again</button>}
          {!!sources.length && <details><summary>View what we found</summary>{sources.map(s => <div key={s.id}><strong>{s.title}</strong><p>{s.status === "PROPOSED" ? s.body.slice(0, 3000) : s.status === "FAILED" ? s.failureMessage || "This page couldn’t be read. Try reading your website again." : "Reading…"}</p></div>)}</details>}
        </div>}
        {!canEdit && <p>Ask a workspace admin to finish these details.</p>}
        <div className="form-actions">{step > 0 ? <button type="button" className="button secondary" onClick={() => { setStep(step - 1); setConfirmed(false); }}><ArrowLeft size={16} aria-hidden="true" />Back</button> : <span />}<button className="button dark" disabled={busy || !canEdit || !organizationId}>{busy ? "Saving…" : step === 0 ? "Continue" : step === 1 ? "Review my brand" : "Finish setup"}<ArrowRight size={16} aria-hidden="true" /></button></div>
      </fieldset>
    </form>}
  </section>;
}
