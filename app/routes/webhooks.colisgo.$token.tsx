import type { ActionFunctionArgs } from "react-router";

import { unauthenticated } from "../shopify.server";
import ShopifyShop from "../models/ShopifyShop.server";
import ShipmentLog from "../models/ShipmentLog.server";
import { decryptSecret } from "../lib/crypto.server";
import {
  verifyColisGoWebhookSignature,
  type ColisGoWebhookEvent,
} from "../lib/colisgo-webhook.server";
import {
  markShopifyFulfillmentDelivered,
  updateShopifyFulfillmentTracking,
} from "../lib/fulfillment.server";

// Inbound webhook FROM ColisGo (shipment.assigned, tracking.updated,
// shipment.delivered, shipment.cancelled, ...) — separate from, and
// unrelated to, Shopify's own webhook system. The per-shop `token` in the
// URL identifies which shop this is for (ColisGo's payload doesn't know
// about Shopify). See shared/services/businessWebhookDispatcher.js in the
// core ColisGo backend for the sender side of this contract.
export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const shop = await ShopifyShop.findOne({ inboundWebhookToken: params.token });
  if (!shop?.colisgo?.webhookSecretCiphertext) {
    return new Response("Not found", { status: 404 });
  }

  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-colisgo-signature");
  const webhookSecret = decryptSecret(shop.colisgo.webhookSecretCiphertext);

  const isValid = verifyColisGoWebhookSignature({
    signingSecret: webhookSecret,
    rawBody,
    signatureHeader,
  });
  if (!isValid) {
    return new Response("Invalid signature", { status: 401 });
  }

  let event: ColisGoWebhookEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const shipmentId = String(
    (event.data as { shipmentId?: string })?.shipmentId || "",
  );
  if (!shipmentId) {
    return new Response();
  }

  const log = await ShipmentLog.findOne({ shop: shop.shop, colisgoShipmentId: shipmentId });
  if (!log) {
    // Nothing to reconcile locally (e.g. a webhook for a shipment created
    // before this app tracked it) — acknowledge so ColisGo doesn't retry.
    return new Response();
  }

  log.events.push({
    type: event.event,
    message: JSON.stringify(event.data).slice(0, 500),
    createdAt: new Date(),
  });

  const status = (event.data as { status?: string })?.status;
  if (status) log.colisgoStatus = status;

  try {
    if (log.shopifyFulfillmentId) {
      const { admin } = await unauthenticated.admin(shop.shop);

      if (event.event === "tracking.updated" && log.trackingUrl) {
        await updateShopifyFulfillmentTracking(admin, {
          fulfillmentId: log.shopifyFulfillmentId,
          trackingNumber: log.colisgoShipmentId || shipmentId,
          trackingUrl: log.trackingUrl,
        });
      }

      if (event.event === "shipment.delivered") {
        await markShopifyFulfillmentDelivered(admin, log.shopifyFulfillmentId);
      }
    }
  } catch (error) {
    console.error(`[webhooks.colisgo] failed to sync ${event.event} to Shopify for ${shop.shop}:`, error);
  }

  await log.save();

  return new Response();
};
