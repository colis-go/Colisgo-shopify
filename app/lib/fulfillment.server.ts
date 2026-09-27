/**
 * Creates a Shopify fulfillment with ColisGo tracking info attached, for the
 * webhook-driven integration style (§7.2 of shopify.md — NOT the deeper
 * Fulfillment Service option). `admin` is the GraphQL client returned by
 * `authenticate.webhook`, `authenticate.admin`, or `unauthenticated.admin`.
 *
 * Untested against a live store (no Partner account available in this
 * environment) — verify against a dev store before relying on it, per
 * shopify.md §13 test matrix.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminGraphqlClient = { graphql: (query: string, options?: any) => Promise<Response> };

interface OpenFulfillmentOrder {
  id: string;
}

async function getOpenFulfillmentOrderIds(
  admin: AdminGraphqlClient,
  orderId: string,
): Promise<OpenFulfillmentOrder[]> {
  const response = await admin.graphql(
    `#graphql
      query OrderFulfillmentOrders($id: ID!) {
        order(id: $id) {
          fulfillmentOrders(first: 10, query: "status:open") {
            nodes { id status }
          }
        }
      }`,
    { variables: { id: orderId } },
  );
  const json = await response.json();
  const nodes = json?.data?.order?.fulfillmentOrders?.nodes ?? [];
  return nodes.filter((node: { status: string }) => node.status === "OPEN");
}

export async function createShopifyFulfillmentWithTracking(
  admin: AdminGraphqlClient,
  params: {
    orderId: string;
    trackingNumber: string;
    trackingUrl: string;
    notifyCustomer?: boolean;
  },
): Promise<{ fulfillmentId: string | null; userErrors: Array<{ field: string[] | null; message: string }> }> {
  const openFulfillmentOrders = await getOpenFulfillmentOrderIds(
    admin,
    params.orderId,
  );

  if (openFulfillmentOrders.length === 0) {
    return { fulfillmentId: null, userErrors: [{ field: null, message: "No open fulfillment orders on this order" }] };
  }

  const response = await admin.graphql(
    `#graphql
      mutation CreateFulfillment($fulfillment: FulfillmentInput!) {
        fulfillmentCreateV2(fulfillment: $fulfillment) {
          fulfillment { id status trackingInfo { number url } }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        fulfillment: {
          lineItemsByFulfillmentOrder: openFulfillmentOrders.map((fo) => ({
            fulfillmentOrderId: fo.id,
          })),
          trackingInfo: {
            number: params.trackingNumber,
            url: params.trackingUrl,
            company: "ColisGo",
          },
          notifyCustomer: params.notifyCustomer ?? true,
        },
      },
    },
  );

  const json = await response.json();
  const result = json?.data?.fulfillmentCreateV2;
  return {
    fulfillmentId: result?.fulfillment?.id ?? null,
    userErrors: result?.userErrors ?? [],
  };
}

export async function updateShopifyFulfillmentTracking(
  admin: AdminGraphqlClient,
  params: { fulfillmentId: string; trackingNumber: string; trackingUrl: string },
): Promise<{ userErrors: Array<{ field: string[] | null; message: string }> }> {
  const response = await admin.graphql(
    `#graphql
      mutation UpdateTracking($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!) {
        fulfillmentTrackingInfoUpdate(fulfillmentId: $fulfillmentId, trackingInfoInput: $trackingInfoInput, notifyCustomer: true) {
          fulfillment { id }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        fulfillmentId: params.fulfillmentId,
        trackingInfoInput: {
          number: params.trackingNumber,
          url: params.trackingUrl,
          company: "ColisGo",
        },
      },
    },
  );
  const json = await response.json();
  return { userErrors: json?.data?.fulfillmentTrackingInfoUpdate?.userErrors ?? [] };
}

export async function markShopifyFulfillmentDelivered(
  admin: AdminGraphqlClient,
  fulfillmentId: string,
): Promise<{ userErrors: Array<{ field: string[] | null; message: string }> }> {
  const response = await admin.graphql(
    `#graphql
      mutation MarkDelivered($fulfillmentEvent: FulfillmentEventInput!) {
        fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
          fulfillmentEvent { id status }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        fulfillmentEvent: { fulfillmentId, status: "DELIVERED" },
      },
    },
  );
  const json = await response.json();
  return { userErrors: json?.data?.fulfillmentEventCreate?.userErrors ?? [] };
}

export async function cancelShopifyFulfillment(
  admin: AdminGraphqlClient,
  fulfillmentId: string,
): Promise<{ userErrors: Array<{ field: string[] | null; message: string }> }> {
  const response = await admin.graphql(
    `#graphql
      mutation CancelFulfillment($id: ID!) {
        fulfillmentCancel(id: $id) {
          fulfillment { id status }
          userErrors { field message }
        }
      }`,
    { variables: { id: fulfillmentId } },
  );
  const json = await response.json();
  return { userErrors: json?.data?.fulfillmentCancel?.userErrors ?? [] };
}
