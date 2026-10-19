import { requireBusiness, rateLimit } from "@/lib/auth";
import { api, AppError } from "@/lib/http";
import { db } from "@/lib/db";
import { businessKnowledge, knowledgeTask } from "@/lib/harness/knowledge-graph";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params, { user, business } = await requireBusiness(id);
    await rateLimit("knowledge:read", user.id, 60);
    const query = new URL(request.url).searchParams, task = knowledgeTask.parse(query.get("task") ?? "copy");
    const channel = query.get("channel") ?? business.channels[0];
    if (!channel || !business.channels.includes(channel)) throw new AppError(400, "Choose a configured business channel.");
    return db.$transaction(tx => businessKnowledge(tx, { businessId: id, organizationId: business.organizationId, actorId: user.id }, task, channel), { isolationLevel: "RepeatableRead" });
  });
}
