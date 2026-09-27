import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import ShopifyShop from "../models/ShopifyShop.server";
import { cancelColisGoShipmentForOrder } from "../lib/shipment.server";
import { cancelShopifyFulfillment } from "../lib/fulfillment.server";
import { ColisGoApiError } from "../lib/colisgo-client.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop: shopDomain, topic, payload, admin } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shopDomain}`);

  const shop = await ShopifyShop.findOne({ shop: shopDomain });
  if (!shop) return new Response();

  const orderIdRaw = (payload as { order_id?: number }).order_id;
  if (!orderIdRaw) return new Response();
  const orderId = `gid://shopify/Order/${orderIdRaw}`;

  try {
    // A partial refund doesn't necessarily mean the shipment should be
    // cancelled, but ColisGo shipments here are fixed-price and
    // non-negotiable — any refund on an order that hasn't shipped yet is
    // treated the same as a cancellation. See TODO.md for a proposed
    // "partial refund, shipment already picked up" reconciliation flow.
    const log = await cancelColisGoShipmentForOrder(shop, orderId, "Refund issued in Shopify");
    if (log?.shopifyFulfillmentId && admin) {
      await cancelShopifyFulfillment(admin, log.shopifyFulfillmentId);
    }
  } catch (error) {
    if (error instanceof ColisGoApiError) {
      console.warn(`[webhooks.refunds.create] ColisGo rejected cancel for ${shopDomain}:`, error.message);
    } else {
      console.error(`[webhooks.refunds.create] failed for ${shopDomain}:`, error);
    }
  }

  return new Response();
};
