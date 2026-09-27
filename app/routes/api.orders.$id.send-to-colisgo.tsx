import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import ShopifyShop from "../models/ShopifyShop.server";
import ShipmentLog from "../models/ShipmentLog.server";
import { createColisGoShipmentForOrder, type NormalizedOrder } from "../lib/shipment.server";
import { createShopifyFulfillmentWithTracking } from "../lib/fulfillment.server";

// Backend for the "Send to ColisGo" Admin UI extension
// (extensions/send-to-colisgo). Reachable both as a full-page loader (embedded
// app session) and as a fetch() from the extension's sandboxed iframe
// (session-token / token-exchange auth) — `authenticate.admin` supports both
// transparently in @shopify/shopify-app-react-router.

function toOrderGid(rawId: string): string {
  return rawId.startsWith("gid://") ? rawId : `gid://shopify/Order/${rawId}`;
}

// The Admin UI extension calls this route as a genuine cross-origin fetch
// from its sandboxed iframe (served from admin.shopify.com), authenticated
// with a session token instead of a cookie — it needs real CORS headers,
// unlike the rest of the embedded app which loads as a same-origin document.
// TODO: verify preflight (OPTIONS) behavior against a real dev store — see
// TODO.md / README "à vérifier avant mise en prod".
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://admin.shopify.com",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

async function fetchOrder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  orderId: string,
): Promise<NormalizedOrder | null> {
  const response = await admin.graphql(
    `#graphql
      query OrderForColisGo($id: ID!) {
        order(id: $id) {
          id
          name
          email
          phone
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          shippingAddress {
            address1 address2 city province provinceCode country countryCode zip phone name
          }
          lineItems(first: 100) {
            nodes { quantity, variant { weight weightUnit } }
          }
        }
      }`,
    { variables: { id: orderId } },
  );
  const json = await response.json();
  const order = json?.data?.order;
  if (!order) return null;

  const totalWeightGrams = (order.lineItems?.nodes || []).reduce(
    (sum: number, item: { quantity: number; variant?: { weight?: number; weightUnit?: string } }) => {
      const weight = item.variant?.weight || 0;
      const unit = item.variant?.weightUnit || "KILOGRAMS";
      const grams = unit === "GRAMS" ? weight : unit === "POUNDS" ? weight * 453.592 : unit === "OUNCES" ? weight * 28.35 : weight * 1000;
      return sum + grams * (item.quantity || 1);
    },
    0,
  );

  return {
    id: order.id,
    legacyResourceId: order.id.split("/").pop() || order.id,
    name: order.name,
    email: order.email,
    phone: order.phone || order.shippingAddress?.phone || null,
    currency: order.currentTotalPriceSet?.shopMoney?.currencyCode || "CAD",
    totalPrice: Number(order.currentTotalPriceSet?.shopMoney?.amount) || 0,
    totalWeightGrams,
    shippingAddress: order.shippingAddress
      ? {
          address1: order.shippingAddress.address1,
          address2: order.shippingAddress.address2,
          city: order.shippingAddress.city,
          province: order.shippingAddress.province,
          provinceCode: order.shippingAddress.provinceCode,
          country: order.shippingAddress.country,
          countryCode: order.shippingAddress.countryCode,
          zip: order.shippingAddress.zip,
          phone: order.shippingAddress.phone,
          name: order.shippingAddress.name,
        }
      : null,
  };
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const orderId = toOrderGid(params.id || "");
  const log = await ShipmentLog.findOne({ shop: session.shop, shopifyOrderId: orderId }).lean();

  return Response.json(
    {
      alreadySent: Boolean(log?.colisgoShipmentId),
      trackingUrl: log?.trackingUrl || null,
      status: log?.colisgoStatus || null,
    },
    { headers: CORS_HEADERS },
  );
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const orderId = toOrderGid(params.id || "");

  const shop = await ShopifyShop.findOne({ shop: session.shop });
  if (!shop) {
    return Response.json(
      { ok: false, error: "Boutique non configurée." },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const order = await fetchOrder(admin, orderId);
  if (!order) {
    return Response.json(
      { ok: false, error: "Commande introuvable." },
      { status: 404, headers: CORS_HEADERS },
    );
  }

  try {
    const log = await createColisGoShipmentForOrder(shop, order, "manual_action");

    if (log.colisgoShipmentId && !log.shopifyFulfillmentId) {
      const { fulfillmentId } = await createShopifyFulfillmentWithTracking(admin, {
        orderId: order.id,
        trackingNumber: log.colisgoShipmentId,
        trackingUrl: log.trackingUrl || "",
      });
      if (fulfillmentId) {
        log.shopifyFulfillmentId = fulfillmentId;
        await log.save();
      }
    }

    return Response.json({ ok: true, trackingUrl: log.trackingUrl }, { headers: CORS_HEADERS });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Erreur inattendue." },
      { status: 400, headers: CORS_HEADERS },
    );
  }
};
