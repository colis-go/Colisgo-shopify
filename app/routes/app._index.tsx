import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import ShopifyShop from "../models/ShopifyShop.server";
import ShipmentLog from "../models/ShipmentLog.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ShopifyShop.findOne({ shop: session.shop }).lean();

  const recentShipments = await ShipmentLog.find({ shop: session.shop })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  return {
    status: shop?.status || "onboarding",
    mode: shop?.colisgo?.mode || "test",
    carrierServiceEnabled: Boolean(shop?.carrierService?.enabled),
    recentShipments: recentShipments.map((entry) => ({
      id: String(entry._id),
      orderName: entry.shopifyOrderName,
      colisgoShipmentId: entry.colisgoShipmentId,
      status: entry.colisgoStatus,
      trackingUrl: entry.trackingUrl,
      totalAmount: entry.pricing?.totalAmount ?? null,
      currency: entry.pricing?.currency ?? "CAD",
      billingStatus: entry.billing?.autoChargeStatus ?? "not_supported",
      createdAt: entry.createdAt,
    })),
  };
};

const STATUS_LABEL: Record<string, string> = {
  onboarding: "À configurer",
  active: "Actif",
  needs_attention: "Nécessite une action",
  disabled: "Désactivé",
};

export default function Index() {
  const { status, mode, carrierServiceEnabled, recentShipments } =
    useLoaderData<typeof loader>();

  return (
    <s-page heading="ColisGo">
      <s-section heading="Statut de la connexion">
        <s-stack direction="inline" gap="base">
          <s-badge tone={status === "active" ? "success" : "warning"}>
            {STATUS_LABEL[status] || status}
          </s-badge>
          <s-badge tone={mode === "live" ? "success" : "info"}>
            Mode {mode === "live" ? "production" : "test"}
          </s-badge>
          <s-badge tone={carrierServiceEnabled ? "success" : "neutral"}>
            Tarifs checkout {carrierServiceEnabled ? "actifs" : "inactifs"}
          </s-badge>
        </s-stack>
        <s-paragraph>
          <s-link href="/app/settings">Ouvrir les réglages ColisGo</s-link>
        </s-paragraph>
      </s-section>

      <s-section heading="Dernières expéditions">
        {recentShipments.length === 0 ? (
          <s-paragraph>
            Aucune expédition ColisGo pour l&apos;instant. Elles apparaîtront ici dès qu&apos;une
            commande déclenchera une création automatique (ou via le bouton « Envoyer à
            ColisGo » sur une commande).
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {recentShipments.map((shipment) => (
              <s-box
                key={shipment.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="inline" gap="base">
                  <s-text>{shipment.orderName || "Commande"}</s-text>
                  <s-badge>{shipment.status || "inconnu"}</s-badge>
                  {shipment.totalAmount != null && (
                    <s-text>
                      {shipment.totalAmount} {shipment.currency}
                    </s-text>
                  )}
                  {shipment.billingStatus === "not_supported" && (
                    <s-badge tone="warning">Paiement manuel requis</s-badge>
                  )}
                  {shipment.trackingUrl && (
                    <s-link href={shipment.trackingUrl} target="_blank">
                      Suivi
                    </s-link>
                  )}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="À propos">
        <s-paragraph>
          Cette app crée automatiquement une expédition ColisGo pour chaque commande payée,
          affiche un tarif ColisGo au checkout (si votre plan Shopify le permet), et synchronise
          le suivi ColisGo vers Shopify.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = boundary.headers;
