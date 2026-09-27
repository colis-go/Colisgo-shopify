import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import ShopifyShop from "../models/ShopifyShop.server";
import { createColisGoShipmentForOrder, type NormalizedOrder } from "../lib/shipment.server";
import { createShopifyFulfillmentWithTracking } from "../lib/fulfillment.server";

interface OrdersPaidPayload {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  currency: string;
  current_total_price: string;
  shipping_address?: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    province_code: string | null;
    country: string | null;
    country_code: string | null;
    zip: string | null;
    phone: string | null;
    name: string | null;
  } | null;
  line_items?: Array<{ grams: number; quantity: number }>;
}

function normalize(payload: OrdersPaidPayload): NormalizedOrder {
  const address = payload.shipping_address;
  return {
    id: `gid://shopify/Order/${payload.id}`,
    legacyResourceId: String(payload.id),
    name: payload.name,
    email: payload.email,
    phone: payload.phone || address?.phone || null,
    currency: payload.currency,
    totalPrice: Number(payload.current_total_price) || 0,
    totalWeightGrams: (payload.line_items || []).reduce(
      (sum, item) => sum + (item.grams || 0) * (item.quantity || 1),
      0,
    ),
    shippingAddress: address
      ? {
          address1: address.address1,
          address2: address.address2,
          city: address.city,
          province: address.province,
          provinceCode: address.province_code,
          country: address.country,
          countryCode: address.country_code,
          zip: address.zip,
          phone: address.phone,
          name: address.name,
        }
      : null,
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop: shopDomain, topic, payload, admin } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shopDomain}`);

  const shop = await ShopifyShop.findOne({ shop: shopDomain });
  if (!shop || shop.status !== "active" || !shop.trigger?.autoCreateEnabled) {
    return new Response();
  }
  if (shop.trigger.event !== "orders/paid") {
    // Merchant chose a different trigger (or manual-only) — orders/create
    // isn't wired up in this v1 (see TODO.md); nothing to do here.
    return new Response();
  }
  if (!admin) {
    console.warn(`[webhooks.orders.paid] no admin session for ${shopDomain}, skipping`);
    return new Response();
  }

  const order = normalize(payload as unknown as OrdersPaidPayload);

  try {
    const log = await createColisGoShipmentForOrder(shop, order, "webhook");

    if (log.colisgoShipmentId && !log.shopifyFulfillmentId) {
      const { fulfillmentId, userErrors } = await createShopifyFulfillmentWithTracking(admin, {
        orderId: order.id,
        trackingNumber: log.colisgoShipmentId,
        trackingUrl: log.trackingUrl || "",
      });
      if (fulfillmentId) {
        log.shopifyFulfillmentId = fulfillmentId;
        log.events.push({ type: "fulfillment_created", message: fulfillmentId, createdAt: new Date() });
        await log.save();
      } else if (userErrors.length) {
        console.warn(`[webhooks.orders.paid] fulfillment error for ${order.name}:`, userErrors);
      }
    }
  } catch (error) {
    console.error(`[webhooks.orders.paid] failed for ${shopDomain} / ${order.name}:`, error);
    // Do not throw: Shopify retries failed webhook deliveries, and a
    // permanent failure (e.g. bad address) would just retry forever. The
    // error is visible in ShipmentLog absence + logs for now; see TODO.md
    // for a merchant-facing retry/alert UI.
  }

  return new Response();
};
