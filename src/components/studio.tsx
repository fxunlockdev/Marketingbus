"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Palette,
  CalendarDays,
  Layers3,
  Brain,
  Plug,
  CreditCard,
  LogOut,
  Plus,
  ArrowUpRight,
  ArrowRight,
  Check,
  Sparkles,
  CircleHelp,
  Image as ImageIcon,
  Film,
  PenLine,
  Compass,
  ChevronRight,
  Trash2,
  ShieldCheck,
} from "lucide-react";
import type { BrandInput } from "@/lib/brand";
import { brandSuggestions } from "@/lib/brand";
import { BrandForm, presets } from "./brand-form";
import { AssetLibrary } from "./asset-library";
import { KnowledgeLibrary } from "./knowledge-library";
import { SocialDashboard } from "./social-dashboard";
import { SocialConnections } from "./social-connections";
import { CompositionEditor } from "./composition-editor";
import { VideoStudio } from "./video-studio";
import { TeamPanel } from "./team-panel";
import { ProductionCard, CalendarView } from "./production-card";
import { WorkflowControls } from "./workflow-controls";
import { BillingPanel } from "./billing-panel";
import { PlanHistory, HistoricalCreative, type PlanView } from "./plan-history";
type Business = BrandInput & {
  id: string;
  organizationId: string;
  version: number;
  confirmedAt: string | null;
  canEdit: boolean;
  memories: { id: string; text: string }[];
  plans: PlanView[];
  auditEvents: {
    id: string;
    action: string;
    detail: string;
    createdAt: string;
  }[];
};
type Page =
  | "Overview"
  | "Brand"
  | "Content plan"
  | "Review inbox"
  | "Calendar"
  | "Publishing & analytics"
  | "Design studio"
  | "Video studio"
  | "Team"
  | "Workflows"
  | "Memory"
  | "Connections"
  | "Credits";
const navigation = [
  { title: "Overview", icon: LayoutDashboard },
  { title: "Brand", icon: Palette },
  { title: "Content plan", icon: CalendarDays },
  { title: "Review inbox", icon: Layers3 },
  { title: "Design studio", icon: ImageIcon },
  { title: "Video studio", icon: Film },
  { title: "Calendar", icon: CalendarDays },
  { title: "Publishing & analytics", icon: ArrowUpRight },
  { title: "Memory", icon: Brain },
  { title: "Connections", icon: Plug },
  { title: "Team", icon: ShieldCheck },
  { title: "Workflows", icon: CalendarDays },
  { title: "Credits", icon: CreditCard },
] as const;
const agents = [
  {
    name: "Brand strategist",
    icon: Compass,
    description: "Find the audience insight and the idea worth making.",
    skills: "Brand Engine · Product marketing",
  },
  {
    name: "Static creative",
    icon: ImageIcon,
    description: "Your product, your identity and carefully composed design.",
    skills: "Brand kit · Image direction · Copy refinement",
  },
  {
    name: "Video director",
    icon: Film,
    description: "A considered story, from first frame to final caption.",
    skills: "Storyboards · Motion design · Video production",
  },
  {
    name: "Campaign operator",
    icon: CalendarDays,
    description: "Keep approved work, your calendar and feedback in sync.",
    skills: "Planning · Publishing · Learning",
  },
];
function Heading({
  kicker,
  title,
  description,
  action,
}: {
  kicker: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{kicker}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function Studio({
  user,
  initialBusinesses,
  wallets,
}: {
  user: { name: string; email: string };
  initialBusinesses: Business[];
  wallets: { organizationId: string; available: number; held: number }[];
}) {
  const router = useRouter();
  useEffect(() => {
    // A payment return only opens billing. It never grants or confirms credits.
    if (["returned", "cancelled"].includes(new URLSearchParams(window.location.search).get("billing") ?? "")) setPage("Credits");
  }, []);
  const [page, setPage] = useState<Page>("Overview"),
    [selected, setSelected] = useState(initialBusinesses[0]?.id ?? ""),
    [editing, setEditing] = useState<"new" | "edit" | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [memory, setMemory] = useState("");
  const business =
    initialBusinesses.find((b) => b.id === selected) ?? initialBusinesses[0];
  const wallet =
    wallets.find((w) => w.organizationId === business?.organizationId) ??
    wallets[0];
  const [planChoice, setPlanChoice] = useState<{ businessId: string; id: string } | null>(null);
  const [loadedPlan, setLoadedPlan] = useState<{ businessId: string; plan: PlanView; canEdit: boolean } | null>(null);
  const [planLoading, setPlanLoading] = useState(false), [planError, setPlanError] = useState("");
  const chosenId = planChoice?.businessId === business?.id ? planChoice?.id : undefined;
  const historical = !!chosenId && chosenId !== business?.plans[0]?.id;
  const activePlan = historical ? loadedPlan?.businessId === business?.id && loadedPlan?.plan.id === chosenId ? loadedPlan.plan : undefined : business?.plans[0];
  const planReadOnly = planLoading || !activePlan || !business?.canEdit || !business.confirmedAt || activePlan.status !== "PROPOSED" || activePlan.brandVersion !== business.version || historical && !loadedPlan?.canEdit;
  const items = activePlan?.items ?? [];
  useEffect(() => {
    const abort = new AbortController(); setPlanError("");
    if (!historical || !business) { setPlanLoading(false); return () => abort.abort(); }
    setPlanLoading(true);
    void (async () => {
      try {
        const response = await fetch(`/api/businesses/${business.id}/plans?plan=${encodeURIComponent(chosenId!)}`, { signal: abort.signal });
        const data = await response.json(); if (!response.ok) throw Error(data.error);
        if (!abort.signal.aborted) setLoadedPlan({ businessId: business.id, plan: data.plan, canEdit: data.canEdit });
      } catch (e) { if (!abort.signal.aborted) { setLoadedPlan(null); setPlanError(e instanceof Error ? e.message : "Unable to load this plan."); } }
      finally { if (!abort.signal.aborted) setPlanLoading(false); }
    })(); return () => abort.abort();
  }, [business, chosenId, historical]);
  function choosePlan(id: string) { if (business) { setPlanError(""); setLoadedPlan(null); setPlanChoice({ businessId: business.id, id }); } }
  function latestPlan() { setPlanChoice(null); setLoadedPlan(null); setPlanError(""); }
  const processing = items.some(i => i.quotes.some(q => q.job && ["QUEUED", "RUNNING", "SUBMITTING"].includes(q.job.status)));
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(() => { if (!document.hidden) router.refresh(); }, 8000);
    return () => clearInterval(timer);
  }, [processing, router]);
  async function production(data: Record<string, unknown>) {
    if (!business) return;
    if (planReadOnly) { setError("This plan is read-only. Open a current confirmed-brand plan before changing work."); return null; }
    const result = await post(`/api/businesses/${business.id}/production`, data);
    if (result) setMessage(data.action === "accept" ? "Production authorized and queued. Credits reserved." : data.action === "quote" ? "Quote prepared. No generation started." : "Saved. Review and calendar state updated.");
    return result;
  }
  async function post(url: string, data: unknown) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      router.refresh();
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save.");
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function act(action: string, extra: Record<string, unknown> = {}) {
    if (!business) return;
    const result = await post(`/api/businesses/${business.id}`, {
      action,
      ...extra,
    });
    if (result)
      setMessage(
        action === "confirm"
          ? "Brand profile confirmed."
          : action === "plan"
            ? "Planning outline saved. No generation or credits used."
            : "Saved to this business.",
      );
    return result;
  }
  function go(p: Page) {
    setPage(p);
    setEditing(null);
    setError("");
    setMessage("");
  }
  async function save(profile: BrandInput) {
    const result = await post(
      editing === "edit" ? `/api/businesses/${business.id}` : "/api/businesses",
      editing === "edit"
        ? { action: "update", version: business.version, profile }
        : profile,
    );
    if (result) {
      if (result.id) setSelected(result.id);
      setEditing(null);
      setPage("Brand");
      setMessage("Profile saved. Review the details, then confirm them.");
    }
  }
  const profile = business
    ? (Object.fromEntries(
        Object.keys({
          name: 1,
          website: 1,
          industry: 1,
          offering: 1,
          audience: 1,
          goal: 1,
          difference: 1,
          proof: 1,
          tone: 1,
          restrictions: 1,
          color: 1,
          designPreset: 1,
          channels: 1,
        }).map((k) => [k, business[k as keyof Business]]),
      ) as BrandInput)
    : undefined;
  return (
    <div className="studio-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <a href="/studio" className="wordmark">
          <span className="brand-mark">
            <i />
          </span>
          marketingbus
        </a>
        <div className="workspace-switch">
          <label htmlFor="business-switch">YOUR WORKSPACE</label>
          <select
            id="business-switch"
            value={business?.id ?? ""}
            onChange={(e) => {
              setSelected(e.target.value);
              setEditing(null);
              setMessage("");
            }}
          >
            {!initialBusinesses.length && (
              <option value="">Your first business</option>
            )}
            {initialBusinesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <button
            className="text-button"
            onClick={() => {
              setEditing("new");
              setError("");
            }}
          >
            <Plus size={14} />
            Add a business
          </button>
        </div>
        <nav aria-label="Studio navigation">
          {navigation.map(({ title, icon: Icon }) => (
            <button
              key={title}
              aria-label={title}
              className={`nav-item ${page === title && !editing ? "active" : ""}`}
              aria-current={page === title && !editing ? "page" : undefined}
              onClick={() => go(title)}
            >
              <Icon size={17} />
              {title}
              {title === "Review inbox" && <span className="nav-count">{items.filter(i => i.revisions[0]?.status === "READY").length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="wallet">
            <div>
              <span>Production credits</span>
              <b>{wallet?.available.toLocaleString() ?? 0}</b>
            </div>
            <p>Shared workspace balance</p>
            <button className="text-button" onClick={() => go("Credits")}>
              View your allowance <ArrowRight size={13} />
            </button>
          </div>
          <div className="user-row">
            <span className="avatar">
              {user.name.slice(0, 2).toUpperCase()}
            </span>
            <div>
              <b>{user.name}</b>
              <small><a href="/account">Account security</a></small>
            </div>
            <button
              className="icon-button"
              aria-label="Sign out"
              onClick={async () => {
                if (await post("/api/auth/logout", {}))
                  window.location.href = "/login";
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <div className="studio-main">
        <header className="topbar">
          <span>{business?.name ?? "Your studio"}</span>
          <ChevronRight size={13} />
          <b>{editing ? "Brand setup" : page}</b>
          <span className="topbar-spacer" />
          <span className="status-pill">
            <i />
            Setup mode
          </span>
          <span className="pilot-badge">PRIVATE PILOT</span>
        </header>
        <main id="main-content" className="content" tabIndex={-1}>
          {!editing && business && ["Content plan", "Review inbox", "Calendar", "Design studio", "Video studio", "Publishing & analytics"].includes(page) && <div className="notice subtle plan-context" aria-busy={planLoading}>
            <p role="status">{planLoading ? "Loading selected plan…" : activePlan ? `Viewing: ${activePlan.title} · brand version ${activePlan.brandVersion}${planReadOnly ? " · read-only" : ""}` : "No plan selected."}</p>
            {historical && <button className="text-button" disabled={busy} onClick={latestPlan}>Return to latest plan</button>}
            {historical && planError && <p role="alert">{planError}</p>}
            {activePlan && planReadOnly && !planLoading && <p>Historical or unconfirmed-brand work and viewer access are read-only. Choose a current plan with editing access to create, approve, schedule or publish. Saved copy is shown without applying today's brand design.</p>}
          </div>}
          {!editing && error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {message && (
            <p className="success" role="status">
              {message}
            </p>
          )}
          {editing ? (
            <BrandForm
              key={`${editing}-${selected}`}
              initial={editing === "edit" ? profile : undefined}
              onSave={save}
              onCancel={() => setEditing(null)}
              busy={busy}
              error={error}
            />
          ) : (
            <>
              {page === "Overview" && (
                <>
                  <section className="hero">
                    <span className="status-pill accent">
                      <i />
                      {business
                        ? "Built around your business"
                        : "Meet your creative workspace"}
                    </span>
                    <h1>
                      <span className="muted">Good marketing.</span>
                      <br />
                      Distinctly yours.
                    </h1>
                    <p>
                      A team that knows your brand, creates with intention,
                      <br className="desktop" /> and brings every piece back to
                      you for approval.
                    </p>
                    <div className="hero-actions">
                      <button
                        className="button elevated"
                        onClick={() =>
                          business ? go("Brand") : setEditing("new")
                        }
                      >
                        {business
                          ? "Review your brand"
                          : "Introduce your business"}
                        <ArrowUpRight size={17} />
                      </button>
                      <button
                        className="text-button"
                        onClick={() => go("Content plan")}
                      >
                        Explore the workflow <ArrowRight size={15} />
                      </button>
                    </div>
                  </section>
                  <section
                    className="brain-map"
                    aria-label="Brand knowledge informs production, then your approval controls publication"
                  >
                    <svg viewBox="0 0 1000 230" aria-hidden="true">
                      <path d="M100 116H385M615 116H900M240 22V65Q240 85 260 85H385M760 22V65Q760 85 740 85H615M240 210V168Q240 148 260 148H385M760 210V168Q760 148 740 148H615" />
                    </svg>
                    <span className="map-chip left-top">
                      Your business knowledge
                    </span>
                    <span className="map-chip right-top">
                      Your approved channels
                    </span>
                    <span className="map-word left">LISTEN</span>
                    <div className="brain-core">
                      <span className="brand-mark large">
                        <i />
                      </span>
                      <b>Creates · Refines · Learns</b>
                      <small>
                        {business?.confirmedAt
                          ? "Brand context confirmed"
                          : "Waiting to learn your brand"}
                      </small>
                    </div>
                    <span className="map-word right">CREATE</span>
                    <div className="map-tags left-tags">
                      <span>Website</span>
                      <span>Brand kit</span>
                      <span>Feedback</span>
                    </div>
                    <div className="map-tags right-tags">
                      <span>Statics</span>
                      <span>Reels</span>
                      <span>Motion</span>
                    </div>
                  </section>
                  <div className="quiet-note">
                    <ShieldCheck size={20} />
                    <p>
                      <b>Your approval stays in the loop.</b>
                      <br />
                      Nothing is generated, charged or published without its
                      required authorization.
                    </p>
                  </div>
                  <div className="two-columns">
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>Your next steps</h2>
                        <span className="muted small">
                          Getting the foundations right
                        </span>
                      </div>
                      {[
                        {
                          name: "Introduce your business",
                          detail: business
                            ? business.name
                            : "Give your team the context it needs",
                          done: !!business,
                          click: () =>
                            business ? go("Brand") : setEditing("new"),
                        },
                        {
                          name: "Confirm your brand",
                          detail: business?.confirmedAt
                            ? `Version ${business.version} confirmed`
                            : "Review your positioning, voice and style",
                          done: !!business?.confirmedAt,
                          click: () =>
                            business ? go("Brand") : setEditing("new"),
                        },
                        {
                          name: "Plan your first batch",
                          detail: items.length
                            ? `${items.length} proposed content directions`
                            : "Choose what is worth making",
                          done: !!items.length,
                          click: () => go("Content plan"),
                        },
                      ].map((s, i) => (
                        <button
                          key={s.name}
                          className="step-row"
                          onClick={s.click}
                        >
                          <span
                            className={`step-number ${s.done ? "done" : ""}`}
                          >
                            {s.done ? <Check size={15} /> : i + 1}
                          </span>
                          <span>
                            <b>{s.name}</b>
                            <small>{s.detail}</small>
                          </span>
                          <ChevronRight size={16} />
                        </button>
                      ))}
                    </section>
                    <section className="panel activity-panel">
                      <div className="panel-heading">
                        <h2>Workspace activity</h2>
                        <span className="small">ACTUAL EVENTS</span>
                      </div>
                      {business?.auditEvents.length ? (
                        business.auditEvents.slice(0, 4).map((e) => (
                          <div className="activity" key={e.id}>
                            <i />
                            <div>
                              <small>{e.action.replaceAll("_", " ")}</small>
                              <p>{e.detail}</p>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="activity-empty">
                          <span className="brand-mark">
                            <i />
                          </span>
                          <h3>A clean start.</h3>
                          <p>
                            Profile updates, approvals and production events
                            will appear here as they happen.
                          </p>
                        </div>
                      )}
                    </section>
                  </div>
                  <div className="section-heading">
                    <h2>Your specialist team</h2>
                    <span className="muted small">
                      Shared brand context. Different crafts.
                    </span>
                  </div>
                  <div className="agent-grid">
                    {agents.map(({ name, icon: Icon, description, skills }) => (
                      <section className="agent-card" key={name}>
                        <Icon size={20} />
                        <h3>{name}</h3>
                        <p>{description}</p>
                        <small>{skills}</small>
                        <span className="tag">Awaiting production setup</span>
                      </section>
                    ))}
                  </div>
                </>
              )}
              {page === "Brand" &&
                (business ? (
                  <>
                    <Heading
                      kicker={`BRAND CONTEXT · VERSION ${business.version}`}
                      title="The world of your brand."
                      description="The foundation every specialist reads before making anything."
                      action={
                        <button
                          className="button secondary"
                          onClick={() => setEditing("edit")}
                        >
                          <PenLine size={15} />
                          Edit profile
                        </button>
                      }
                    />
                    <div className="brand-summary">
                      <div
                        className={`design-preview large-preview ${business.designPreset}`}
                        style={
                          {
                            "--brand-accent": business.color,
                          } as React.CSSProperties
                        }
                      >
                        <small>{business.name}</small>
                        <strong>
                          {business.difference || "Your point\nof view."}
                        </strong>
                        <span>
                          {business.industry || "Your brand direction"}
                        </span>
                      </div>
                      <section className="panel brand-facts">
                        <div className="panel-heading">
                          <h2>{business.name}</h2>
                          <span className="tag">
                            {business.confirmedAt
                              ? "Confirmed"
                              : "Needs your review"}
                          </span>
                        </div>
                        {[
                          ["Offering", business.offering],
                          ["Audience", business.audience],
                          ["Objective", business.goal],
                          ["Voice", business.tone],
                          ["Approved proof", business.proof || "Not provided"],
                          [
                            "Restrictions",
                            business.restrictions || "Not provided",
                          ],
                        ].map(([label, text]) => (
                          <div className="fact" key={label}>
                            <span>{label}</span>
                            <p>{text}</p>
                          </div>
                        ))}
                        <div className="preset-footer">
                          <span
                            className="color-dot"
                            style={{ background: business.color }}
                          />
                          <span>
                            {business.color} ·{" "}
                            {
                              presets.find(
                                (p) => p.id === business.designPreset,
                              )?.name
                            }
                          </span>
                          <small>Layout preview</small>
                        </div>
                        {!business.confirmedAt && (
                          <button
                            disabled={busy}
                            className="button dark"
                            onClick={() =>
                              act("confirm", { version: business.version })
                            }
                          >
                            <Check size={16} />
                            Confirm this brand profile
                          </button>
                        )}
                      </section>
                    </div>
                    <AssetLibrary key={business.id} businessId={business.id} />
                    <KnowledgeLibrary key={`sources-${business.id}`} businessId={business.id} />
                    <div className="section-heading">
                      <h2>Give your team a stronger brief</h2>
                      <span className="tag">
                        Profile checks · not an AI audit
                      </span>
                    </div>
                    <div className="suggestion-grid">
                      {brandSuggestions(business).map((s) => (
                        <section className="panel suggestion" key={s.id}>
                          <CircleHelp size={20} />
                          <h3>{s.title}</h3>
                          <p>{s.reason}</p>
                          <small>{s.action}</small>
                          <button
                            className="text-button"
                            onClick={() => setEditing("edit")}
                          >
                            Update profile <ArrowUpRight size={14} />
                          </button>
                        </section>
                      ))}
                      {!brandSuggestions(business).length && (
                        <div className="notice">
                          Your core profile fields are filled. AI brand
                          recommendations will become available after the
                          provider workflow is connected and evaluated.
                        </div>
                      )}
                    </div>
                    <div className="notice">
                      <GlobeIcon />
                      <p>
                        <b>Website research and asset uploads</b>
                        <br />
                        Firecrawl extraction and private file ingestion are
                        planned next. Your profile is currently based on the
                        answers you supplied.
                      </p>
                    </div>
                  </>
                ) : (
                  <Empty
                    title="Start with your business."
                    text="Your brand profile gives every agent a shared point of view."
                    action={() => setEditing("new")}
                    label="Introduce your business"
                  />
                ))}
              {page === "Content plan" &&
                (business ? (
                  <>
                    <Heading
                      kicker="THE NEXT CHAPTER"
                      title="A plan with a purpose."
                      description="Start with your business priorities. Creative production follows after direction and budget are approved."
                      action={
                        <button
                          className="button dark"
                          disabled={busy || !business.confirmedAt}
                          onClick={() =>
                            act("plan", { version: business.version })
                          }
                        >
                          Propose a planning outline
                          <ArrowRight size={16} />
                        </button>
                      }
                    />
                    {!business.confirmedAt && (
                      <div className="notice">
                        Confirm your brand profile first to enable planning.
                      </div>
                    )}
                    <div className="notice subtle">
                      Planning outlines are free. Add a direction and request a quote for copy production. Image generation requires verified provider configuration and an available credit balance. Video studio supports bounded local motion reels; generated footage is not enabled yet.
                    </div>
                    <PlanHistory key={business.id} businessId={business.id} selectedId={activePlan?.id} busy={busy || planLoading} onChoose={choosePlan} />
                    {items.length ? (
                      <div className="plan-grid">
                        {items.map(item => planReadOnly ? <HistoricalCreative key={item.id} item={item} /> : <ProductionCard key={`${item.id}:${item.revisions[0]?.version || 0}`} item={item} brand={business} busy={busy} post={production} />)}
                      </div>
                    ) : (
                      <Empty
                        title="Room for your next ideas."
                        text="Confirm your brand, then create the first planning outline."
                      />
                    )}
                  </>
                ) : (
                  <Empty
                    title="A little context first."
                    text="Create a business profile before planning its content."
                    action={() => setEditing("new")}
                    label="Set up a business"
                  />
                ))}
              {page === "Review inbox" && (
                <>
                  <Heading
                    kicker="YOU HAVE THE FINAL SAY"
                    title="Work worth putting your name on."
                    description="Review the exact creative, request a focused change, or approve it for your calendar."
                  />
                  {business && items.some(i => i.revisions.length) ? <div className="production-list">{items.filter(i => i.revisions.length).map(item => planReadOnly ? <HistoricalCreative key={item.id} item={item} /> : <ProductionCard key={`${item.id}:${item.revisions[0]?.version}`} item={item} brand={business} busy={busy} post={production} review />)}</div> : <Empty title="Nothing to review yet." text="Produced copy and layout previews will appear here. A planning outline is not a finished creative." />}
                  <div className="review-explainer">
                    {[
                      ["Approve", "Approval belongs to one exact revision."],
                      [
                        "Request changes",
                        "Change the affected copy, image or scene.",
                      ],
                      ["Reject", "Shelve the work without an automatic retry."],
                    ].map(([title, text]) => (
                      <div key={title}>
                        <h3>{title}</h3>
                        <p>{text}</p>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {page === "Calendar" && <><Heading kicker="MAKE ROOM FOR GOOD WORK" title="Your publishing plan." description="A dated agenda for the selected plan's exact, approved versions. Change plans from Content plan to view another agenda." /><CalendarView items={items} post={production} busy={busy || planReadOnly} /></>}
              {page === "Publishing & analytics" && <><Heading kicker="FROM APPROVAL TO EVIDENCE" title="Publishing & analytics" description="Business-wide outcomes and measured experiments. Only current selected-plan items are offered for new publishing requests." />{business ? <SocialDashboard key={`${business.id}:${activePlan?.id}`} businessId={business.id} items={planReadOnly ? [] : items} /> : <Empty title="Choose a business first." text="Publishing and performance belong to a specific business." />}</>}
              {page === "Design studio" && <><Heading kicker="YOUR ASSETS, PRECISELY PLACED" title="Design studio" description="Editable, versioned compositions and downloadable files. No model cost for layout changes." />{business && !planReadOnly ? <CompositionEditor key={`${business.id}:${activePlan?.id}`} businessId={business.id} items={items} /> : <Empty title="Choose a current plan." text="Open Content plan and select a current confirmed-brand plan with editing access. Historical copy remains available in the Review inbox." />}</>}
              {page === "Video studio" && <><Heading kicker="STORY, TIMING AND REVIEW" title="Video studio" description="Versioned storyboards and captioned motion reels made from approved originals and artwork." />{business && !planReadOnly ? <VideoStudio key={`${business.id}:${activePlan?.id}`} businessId={business.id} items={items} /> : <Empty title="Choose a current plan." text="Storyboarding needs a current confirmed-brand plan and editing access. Historical copy remains available in the Review inbox." />}</>}
              {page === "Team" && <><Heading kicker="THE PEOPLE BEHIND THE WORK" title="Workspace team" description="Invite teammates and control who can view, create and administer your businesses." />{business ? <TeamPanel key={business.organizationId} organizationId={business.organizationId} /> : <Empty title="Choose a business first." text="Team access applies to its workspace." />}</>}
              {page === "Workflows" && <><Heading kicker="CONTROL THE WORK" title="Workflows" description="Independent review and bounded recurring planning." />{business ? <WorkflowControls key={business.id} businessId={business.id} /> : <Empty title="Choose a business first." text="Workflow policies belong to one business." />}</>}
              {page === "Memory" &&
                (business ? (
                  <>
                    <Heading
                      kicker="A BRAND THAT STAYS YOURS"
                      title="Keep the useful lessons."
                      description="Explicit preferences apply only to this business. One-off edits will stay with their creative."
                    />
                    <form
                      className="panel memory-form"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (await act("memory", { text: memory }))
                          setMemory("");
                      }}
                    >
                      <label htmlFor="memory">
                        What should this brand always remember?
                      </label>
                      <textarea
                        id="memory"
                        required
                        minLength={3}
                        maxLength={1000}
                        placeholder="e.g. Use our product's full name. Avoid emojis in LinkedIn posts."
                        value={memory}
                        onChange={(e) => setMemory(e.target.value)}
                      />
                      <button className="button dark" disabled={busy}>
                        Save brand preference
                      </button>
                    </form>
                    <div className="memory-list">
                      {business.memories.map((m) => (
                        <section className="panel memory-card" key={m.id}>
                          <span className="tag">Your explicit preference</span>
                          <p>{m.text}</p>
                          <button
                            className="icon-button"
                            aria-label={`Remove preference: ${m.text}`}
                            disabled={busy}
                            onClick={() => act("forget", { memoryId: m.id })}
                          >
                            <Trash2 size={16} />
                          </button>
                        </section>
                      ))}
                    </div>
                    {!business.memories.length && (
                      <p className="muted">
                        No preferences saved yet. No lessons are inferred from
                        nonexistent performance data.
                      </p>
                    )}
                  </>
                ) : (
                  <Empty
                    title="First, give your brand a home."
                    text="Preferences are saved to a specific business."
                    action={() => setEditing("new")}
                    label="Create business"
                  />
                ))}
              {page === "Connections" && (
                <>
                  <Heading
                    kicker="YOUR PUBLISHING CHANNELS"
                    title="Publishing destinations"
                    description="Your business's social accounts for publishing approved content and tracking performance."
                  />
                  {business ? <SocialConnections key={business.id} businessId={business.id} /> : <p>Create or select a business to manage its publishing destinations.</p>}
                </>
              )}
              {page === "Credits" && (
                <>
                  <Heading
                    kicker="A CLEAR BUDGET FOR GOOD WORK"
                    title="Know what goes into it."
                    description="Plan production, protect room for revisions, and see where every credit goes."
                  />
                  {wallet ? <BillingPanel key={wallet.organizationId} organizationId={wallet.organizationId} /> : <Empty title="No workspace billing available." text="Select a workspace to view its balance." />}
                </>
              )}
            </>
          )}
        </main>
        <footer className="app-footer">
          MARKETINGBUS · PRIVATE PILOT
          <span>Thoughtful work starts with a thoughtful brief.</span>
        </footer>
      </div>
    </div>
  );
}
function Empty({
  title,
  text,
  action,
  label,
}: {
  title: string;
  text: string;
  action?: () => void;
  label?: string;
}) {
  return (
    <section className="empty-state">
      <div className="empty-icon">
        <Sparkles size={24} />
      </div>
      <h2>{title}</h2>
      <p>{text}</p>
      {action && (
        <button className="button elevated" onClick={action}>
          {label}
          <ArrowRight size={16} />
        </button>
      )}
    </section>
  );
}
function GlobeIcon() {
  return <Compass size={20} aria-hidden="true" />;
}
