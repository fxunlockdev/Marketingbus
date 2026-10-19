"use client";
import { Facebook, Instagram, Linkedin, ArrowRight } from "lucide-react";
export function DestinationCatalogue({ onSetup }: { onSetup: () => void }) {
  const destinations = [
    { name: "Instagram", Icon: Instagram, account: "Professional account linked to a Facebook Page", formats: "Image posts and Reels" },
    { name: "Facebook", Icon: Facebook, account: "Facebook Page you manage", formats: "Page posts, images and Reels" },
    { name: "LinkedIn", Icon: Linkedin, account: "Company Page you administer", formats: "Company posts, images and video" },
  ];
  return <section aria-label="Publishing destination catalogue">
    <div className="destination-setup"><div><h2>Choose where your brand shows up</h2><p>Create your business first, then connect its accounts. Connection availability depends on platform setup and permissions.</p></div><button className="button dark" onClick={onSetup}>Set up your business <ArrowRight size={16} aria-hidden="true" /></button></div>
    <div className="destination-grid">{destinations.map(({ name, Icon, account, formats }) => <article className="destination-card" key={name}>
      <Icon size={26} aria-hidden="true" /><h3>{name}</h3><p>{account}</p><p className="muted">{formats}</p><span className="destination-state">Business setup required</span>
    </article>)}</div>
    <p className="muted">X and YouTube are not available yet. Only publishing destinations belong here—AI providers are managed by Marketingbus.</p>
    <p>Connecting an account never approves content. Only approved, scheduled versions can be published.</p>
  </section>;
}
