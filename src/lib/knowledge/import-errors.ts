// Fixed, customer-safe messages only. Never expose upstream bodies, URLs or credentials.
const messages: Record<string, string> = {
  IMPORT_INTERRUPTED: "The website import was interrupted. It was not retried automatically.",
  SOURCE_AUTHORITY_CHANGED: "The person who requested this import no longer has editing permission. An authorized editor can submit a new import.",
  SOURCE_CONTEXT_CHANGED: "The saved website request changed. Review the address and submit a new import.",
  SCRAPER_AUTH_REQUIRED: "Website import needs an administrator to check the scraper connection. Your business details are saved.",
  SCRAPER_BUSY: "The website importer is busy. Please try again later.",
  SCRAPER_UNAVAILABLE: "The website importer is temporarily unavailable. Your business details are saved.",
  SCRAPER_TIMEOUT: "The website took too long to load. Try a simpler page from your business website.",
  SOURCE_ADDRESS_RESTRICTED: "This website address cannot be imported. Use a public HTTPS business website.",
  SOURCE_REDIRECT_CHANGED: "The page redirected to a different website address. Review that address and submit it explicitly.",
  SOURCE_PAGE_UNAVAILABLE: "The website did not return a successful page. Check that the page is publicly accessible.",
  SOURCE_TOO_LARGE: "This page exceeds the import size limit. Try a shorter page, such as your About page.",
  SOURCE_INVALID_RESULT: "The importer could not extract usable text from this page. Try another page or upload a document.",
  SOURCE_IMPORT_FAILED: "The website import failed. No automatic retry was made.",
};
export function sourceImportMessage(code: string | null | undefined) {
  return code && Object.hasOwn(messages, code) ? messages[code] : messages.SOURCE_IMPORT_FAILED;
}
export class SourceImportError extends Error {
  constructor(readonly code: string) { super(sourceImportMessage(code)); }
}
