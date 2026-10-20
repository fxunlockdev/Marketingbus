import { z } from "zod";

// Convenience normalization only. Server-side public URL and DNS/egress checks still apply.
export function websiteAddress(raw: string) {
  const value = raw.trim();
  return /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
}
export const setupDetails = z.object({
  socialProfiles: z.array(z.object({
    platform: z.enum(["Instagram", "Facebook", "LinkedIn"]),
    url: z.string().trim().max(500),
  }).strict()).max(3).default([]),
  brandBook: z.enum(["undecided", "upload", "create", "skip"]).default("undecided"),
}).strict();
export type SetupDetails = z.infer<typeof setupDetails>;

export function socialAddress(platform: string, raw: string) {
  const hosts: Record<string, string> = { Instagram: "www.instagram.com", Facebook: "www.facebook.com", LinkedIn: "www.linkedin.com" };
  const host = hosts[platform];
  if (!host) throw Error("Choose Instagram, Facebook or LinkedIn.");
  const value = raw.trim();
  const isHandle = /^@?[a-z\d_.-]+$/i.test(value) && !value.includes(".com");
  const url = new URL(isHandle ? `https://${host}/${platform === "LinkedIn" ? "company/" : ""}${value.replace(/^@/, "")}` : websiteAddress(value));
  if (url.protocol !== "https:" || url.username || url.password || url.port || ![host, host.replace(/^www\./, "")].includes(url.hostname) || !/^\/[a-z\d_./-]+$/i.test(url.pathname) || url.pathname === "/")
    throw Error(`Enter a public ${platform} profile link or handle.`);
  url.search = ""; url.hash = "";
  return url.href;
}

// A visibly labelled excerpt, not an AI interpretation or an approved brand fact.
export function websiteExcerpt(body: string) {
  return body.split(/\n+/).map(line => line.trim()).find(line =>
    line.length >= 45 && line.length <= 1200 && !/^[#>*|!\[]/.test(line) &&
    !/https?:|ignore.*instructions|system prompt|cookie|privacy policy|all rights reserved/i.test(line)) ?? "";
}
