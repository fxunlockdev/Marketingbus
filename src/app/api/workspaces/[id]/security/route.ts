import { requireWorkspace, rateLimit } from "@/lib/auth";
import { api, readBody } from "@/lib/http";
import { setWorkspaceSecurity } from "@/lib/identity/workspace-security";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params, user = await requireWorkspace(id);
    const input = await readBody(request);
    await rateLimit("workspace:security", user.id, 10);
    return setWorkspaceSecurity(id, user.id, user.authVersion, input);
  });
}
