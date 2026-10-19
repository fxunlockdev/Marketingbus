"use client";
import { contentPreferences, strategies, type ContentPreferences } from "@/lib/onboarding/preferences";
export function ContentPreferencesFields({ value, onChange }: { value?: ContentPreferences; onChange: (value: ContentPreferences) => void }) {
  const current = contentPreferences.parse(value ?? {});
  return <fieldset><legend>Creative preferences</legend><div className="form-grid">
    <label>Content strategy<select value={current.strategy} onChange={e => onChange({ ...current, strategy: e.target.value as ContentPreferences["strategy"] })}>{strategies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    <label>Writing language<select value={current.language} onChange={e => onChange({ ...current, language: e.target.value as ContentPreferences["language"] })}><option>English (US)</option><option>English (UK)</option></select></label>
    <label>Image direction<select value={current.visualStyle} onChange={e => onChange({ ...current, visualStyle: e.target.value as ContentPreferences["visualStyle"] })}><option value="natural">Natural light, everyday context</option><option value="studio">Clean studio, controlled lighting</option><option value="cinematic">Cinematic light, considered contrast</option></select></label>
    <label>Business type<select value={current.businessType} onChange={e => onChange({ ...current, businessType: e.target.value as ContentPreferences["businessType"] })}><option value="services">Services</option><option value="local">Local business</option><option value="products">Products</option></select></label>
  </div><p className="small muted">Saving changes requires brand confirmation again before new production. These preferences do not authorize automatic spending or posting.</p></fieldset>;
}
