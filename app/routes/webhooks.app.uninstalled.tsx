import type { ActionFunctionArgs } from "react-router";
import { authenticate, sessionStorage } from "../shopify.server";
import ShopifyShop from "../models/ShopifyShop.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has
  // already been uninstalled.
  if (session) {
    const sessions = await sessionStorage.findSessionsByShop(shop);
    if (sessions.length > 0) {
      await sessionStorage.deleteSessions(sessions.map((s) => s.id));
    }
  }

  // Keep the ShopifyShop + ShipmentLog history (useful if the merchant
  // reinstalls, and for support/dispute lookups) but mark it uninstalled and
  // disable the carrier service / order triggers so a stale install can't
  // silently keep creating shipments.
  await ShopifyShop.findOneAndUpdate(
    { shop },
    {
      status: "disabled",
      uninstalledAt: new Date(),
      "trigger.autoCreateEnabled": false,
      "carrierService.enabled": false,
    },
  );

  return new Response();
};
