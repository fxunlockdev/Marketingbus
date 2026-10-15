import { AppError } from "../http";
import { paymentAdapter, type PaymentAdapter } from "./contracts";
import { ingestVerifiedPayment } from "./payments";
export async function receivePaymentWebhook(request: Request, adapter: PaymentAdapter | null = paymentAdapter()) {
  if (!adapter) throw new AppError(503, "Payments are not activated.");
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, "Payment event body required.");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.byteLength;
    if (size > 262144) { await reader.cancel(); throw new AppError(413, "Payment event too large."); }
    chunks.push(part.value);
  }
  // Preserve exact bytes for signature verification. No browser-origin check on a server webhook.
  const event = await adapter.verify(Buffer.concat(chunks), request.headers);
  return ingestVerifiedPayment(event);
}
