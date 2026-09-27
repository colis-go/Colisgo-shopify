import type { ActionFunctionArgs } from "react-router";
import { authenticate, sessionStorage } from "../shopify.server";
import ShopifyShop from "../models/ShopifyShop.server";
import ShipmentLog from "../models/ShipmentLog.server";

// Mandatory GDPR/privacy webhook, sent ~48h after uninstall. Fully erase
// this shop's data: the dedicated ShopifyShop config (including encrypted
// ColisGo credentials) and its ShipmentLog history, plus any lingering
// session rows.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  await Promise.all([
    ShopifyShop.deleteOne({ shop }),
    ShipmentLog.deleteMany({ shop }),
    (async () => {
      const sessions = await sessionStorage.findSessionsByShop(shop);
      if (sessions.length > 0) {
        await sessionStorage.deleteSessions(sessions.map((s) => s.id));
      }
    })(),
  ]);

  return new Response();
};
