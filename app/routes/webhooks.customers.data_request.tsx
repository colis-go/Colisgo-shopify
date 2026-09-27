import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// Mandatory GDPR/privacy webhook (App Store review requirement). This app
// does not persist customer PII: ShipmentLog only stores the Shopify order
// id/name, ColisGo shipment id/status and pricing — the customer's email
// and phone are sent straight through to the ColisGo partner API and never
// written to our own database. There is nothing to compile/disclose here.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`, {
    customerId: (payload as { customer?: { id?: number } })?.customer?.id,
  });
  return new Response();
};
