import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// Mandatory GDPR/privacy webhook. Same reasoning as customers/data_request:
// no customer PII is stored by this app (see that route's comment), so
// there is nothing to redact on our side. Acknowledge and return.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`, {
    customerId: (payload as { customer?: { id?: number } })?.customer?.id,
  });
  return new Response();
};
