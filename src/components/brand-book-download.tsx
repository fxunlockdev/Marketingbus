"use client";
import { brandBookHtml } from "@/lib/onboarding/brand-book";
import type { BrandInput } from "@/lib/brand";
export function BrandBookDownload({ profile, draft = false }: { profile: BrandInput; draft?: boolean }) {
  return <button type="button" className="button secondary" onClick={() => {
    const href = URL.createObjectURL(new Blob([brandBookHtml(profile, draft)], { type: "text/html;charset=utf-8" }));
    const link = document.createElement("a"); link.href = href; link.download = "brand-book.html"; link.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }}>Download {draft ? "draft " : ""}brand book</button>;
}
