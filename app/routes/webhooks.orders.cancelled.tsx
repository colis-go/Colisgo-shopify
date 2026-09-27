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

  const orderId = `gid://shopify/Order/${(payload as { id: number }).id}`;

  try {
    const log = await cancelColisGoShipmentForOrder(shop, orderId, "Order cancelled in Shopify");
    if (log?.shopifyFulfillmentId && admin) {
      await cancelShopifyFulfillment(admin, log.shopifyFulfillmentId);
    }
  } catch (error) {
    if (error instanceof ColisGoApiError) {
      console.warn(`[webhooks.orders.cancelled] ColisGo rejected cancel for ${shopDomain}:`, error.message);
    } else {
      console.error(`[webhooks.orders.cancelled] failed for ${shopDomain}:`, error);
    }
  }

  return new Response();
};
