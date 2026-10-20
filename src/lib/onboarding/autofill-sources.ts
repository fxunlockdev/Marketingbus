type Source = { id: string; sourceUrl: string; status: string };

// Caller supplies only this business's sources, newest first. Never substitute
// an older successful import for a newer failed or unfinished attempt.
export function selectAutofillSources<T extends Source>(
  sources: T[], websiteUrl: string, socialUrls: string[],
) {
  const website = sources.find(source => source.sourceUrl === websiteUrl);
  const documents = sources.filter(source => !source.sourceUrl && source.status === "PROPOSED");
  const profiles = [...new Set(socialUrls)].filter(url => url && url !== websiteUrl)
    .map(url => sources.find(source => source.sourceUrl === url))
    .filter((source): source is T => !!source);
  // Do not consume the one authorized analysis before an already queued website
  // has arrived merely because a brand book uploaded faster.
  if (website && ["QUEUED", "FETCHING"].includes(website.status)) {
    return { status: "WAITING" as const, sourceIds: [] };
  }
  const readyProfiles = profiles.filter(source => source.status === "PROPOSED");
  // Reserve room for one book and one available public profile. Keep the same
  // three-source reading and credit ceilings; unavailable social pages are optional.
  const candidates = [
    ...(website?.status === "PROPOSED" ? [website] : []),
    ...documents.slice(0, 1), ...readyProfiles.slice(0, 1),
    ...documents.slice(1), ...readyProfiles.slice(1),
  ];
  const selected = [...new Map(candidates.map(source => [source.id, source])).values()].slice(0, 3);
  if (selected.length) return { status: "READY" as const, sourceIds: selected.map(source => source.id) };
  return {
    status: profiles.some(source => ["QUEUED", "FETCHING"].includes(source.status)) ? "WAITING" as const : "IMPORT_REQUIRED" as const,
    sourceIds: [],
  };
}
