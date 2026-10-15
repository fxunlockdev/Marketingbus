import { api } from "@/lib/http";
import { receivePaymentWebhook } from "@/lib/billing/webhook";
export async function POST(request: Request) { return api(() => receivePaymentWebhook(request)); }
