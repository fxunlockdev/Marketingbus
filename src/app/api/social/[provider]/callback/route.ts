import { requireSessionId } from "@/lib/auth";
import { completeSocialOAuth, configuredSocialOAuthAdapters } from "@/lib/social/oauth";
export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  try {
    const { provider } = await context.params;
    const canonical = ({ facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn" } as Record<string, string>)[provider];
    const result = await completeSocialOAuth(await requireSessionId(), canonical, new URL(request.url).searchParams, configuredSocialOAuthAdapters());
    // Relative fixed local destination: no provider query, authorization code or state is forwarded.
    return new Response(null, { status: 303, headers: { ...headers, Location: `/social-connect?business=${encodeURIComponent(result.businessId)}` } });
  } catch {
    return new Response(null, { status: 303, headers: { ...headers, Location: "/social-connect?failed=1" } });
  }
}
