import crypto from "node:crypto";

/**
 * Verifies inbound ColisGo webhooks (shipment.assigned, tracking.updated,
 * shipment.delivered, shipment.cancelled, ...). Mirrors
 * shared/services/businessWebhookDispatcher.js#verifyBusinessWebhookSignature
 * in the core ColisGo backend exactly — do not change this without changing
 * that file too, they must stay in sync.
 */

function hashSecret(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createSignature(secretHash: string, body: string): string {
  return crypto.createHmac("sha256", secretHash).update(body).digest("hex");
}

export function verifyColisGoWebhookSignature(params: {
  signingSecret: string;
  rawBody: string;
  signatureHeader: string | null;
}): boolean {
  const { signingSecret, rawBody, signatureHeader } = params;
  const signature = String(signatureHeader || "").replace(/^sha256=/, "");
  if (!signingSecret || !rawBody || !signature) return false;

  const expected = createSignature(hashSecret(signingSecret), rawBody);

  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== actualBuffer.length) return false;

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

export interface ColisGoWebhookEvent {
  id: string;
  event:
    | "shipment.created"
    | "shipment.assigned"
    | "shipment.picked_up"
    | "shipment.in_transit"
    | "shipment.delivered"
    | "shipment.cancelled"
    | "tracking.updated"
    | "ticket.created";
  createdAt: string;
  data: Record<string, unknown>;
}
