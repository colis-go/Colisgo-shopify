import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation, useActionData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import ShopifyShop from "../models/ShopifyShop.server";
import { encryptSecret, lastFour, randomToken } from "../lib/crypto.server";
import { listShipments, ColisGoApiError } from "../lib/colisgo-client.server";
import { buildAddressQuery, geocodeAddress } from "../lib/geocoder.server";

async function getOrCreateShop(shop: string) {
  let doc = await ShopifyShop.findOne({ shop });
  if (!doc) {
    doc = await ShopifyShop.create({
      shop,
      status: "onboarding",
      carrierService: { token: randomToken(16), enabled: false, currency: "CAD" },
      inboundWebhookToken: randomToken(16),
    });
  }
  return doc;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const doc = await getOrCreateShop(session.shop);
  const appUrl = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");

  return {
    shop: session.shop,
    status: doc.status,
    colisgo: {
      mode: doc.colisgo?.mode || "test",
      hasApiKey: Boolean(doc.colisgo?.apiKeyCiphertext),
      apiKeyLastFour: doc.colisgo?.apiKeyLastFour || null,
      hasWebhookSecret: Boolean(doc.colisgo?.webhookSecretCiphertext),
      webhookSecretLastFour: doc.colisgo?.webhookSecretLastFour || null,
      lastVerifiedAt: doc.colisgo?.lastVerifiedAt ?? null,
      lastVerificationError: doc.colisgo?.lastVerificationError ?? null,
    },
    pickupLocation: doc.pickupLocation,
    defaultPackage: doc.defaultPackage,
    trigger: doc.trigger,
    billing: doc.billing,
    carrierService: {
      enabled: Boolean(doc.carrierService?.enabled),
      callbackUrl: `${appUrl}/carrier/rates/${doc.carrierService?.token}`,
    },
    inboundWebhookUrl: `${appUrl}/webhooks/colisgo/${doc.inboundWebhookToken}`,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const doc = await getOrCreateShop(session.shop);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  try {
    if (intent === "saveCredentials") {
      const apiKey = String(formData.get("apiKey") || "").trim();
      const webhookSecret = String(formData.get("webhookSecret") || "").trim();

      if (!/^sk_(test|live)_/.test(apiKey)) {
        return { intent, ok: false, error: "Clé API ColisGo invalide (doit commencer par sk_test_ ou sk_live_)." };
      }

      // Validate the key actually works before saving it.
      try {
        await listShipments(apiKey, { limit: 1 });
      } catch (error) {
        const message = error instanceof ColisGoApiError ? error.message : "Impossible de joindre l'API ColisGo.";
        doc.colisgo!.lastVerificationError = message;
        await doc.save();
        return { intent, ok: false, error: `Clé rejetée par ColisGo : ${message}` };
      }

      doc.colisgo!.mode = apiKey.startsWith("sk_live_") ? "live" : "test";
      doc.colisgo!.apiKeyCiphertext = encryptSecret(apiKey);
      doc.colisgo!.apiKeyLastFour = lastFour(apiKey);
      if (webhookSecret) {
        doc.colisgo!.webhookSecretCiphertext = encryptSecret(webhookSecret);
        doc.colisgo!.webhookSecretLastFour = lastFour(webhookSecret);
      }
      doc.colisgo!.lastVerifiedAt = new Date();
      doc.colisgo!.lastVerificationError = null;
      if (doc.pickupLocation?.coordinates) doc.status = "active";
      await doc.save();
      return { intent, ok: true };
    }

    if (intent === "savePickupLocation") {
      const address = String(formData.get("address") || "").trim();
      const city = String(formData.get("city") || "").trim();
      const province = String(formData.get("province") || "").trim();
      const country = String(formData.get("country") || "CA").trim().toUpperCase();
      const postalCode = String(formData.get("postalCode") || "").trim();
      const companyName = String(formData.get("companyName") || "").trim();
      const phone = String(formData.get("phone") || "").trim();

      if (!address || !city || !postalCode) {
        return { intent, ok: false, error: "Adresse, ville et code postal sont requis." };
      }

      const query = buildAddressQuery({ address1: address, city, province, postalCode, country });
      const geocoded = await geocodeAddress(query);
      if (!geocoded) {
        return { intent, ok: false, error: `Impossible de géolocaliser cette adresse : "${query}".` };
      }

      doc.pickupLocation = {
        companyName: companyName || null,
        address,
        city,
        province: province || null,
        country,
        postalCode,
        phone: phone || null,
        coordinates: geocoded.coordinates,
        geocodedAt: new Date(),
      };
      if (doc.colisgo?.apiKeyCiphertext) doc.status = "active";
      await doc.save();
      return { intent, ok: true };
    }

    if (intent === "saveDefaults") {
      doc.defaultPackage = {
        weight: Number(formData.get("weight")) || 1,
        category: String(formData.get("category") || "other") as NonNullable<typeof doc.defaultPackage>["category"],
        declaredValue: Number(formData.get("declaredValue")) || 50,
        isFragile: formData.get("isFragile") === "on",
      };
      doc.trigger = {
        event: String(formData.get("triggerEvent") || "orders/paid") as NonNullable<typeof doc.trigger>["event"],
        autoCreateEnabled: formData.get("autoCreateEnabled") === "on",
      };
      doc.billing = {
        autoChargeRequested: formData.get("autoChargeRequested") === "on",
      };
      await doc.save();
      return { intent, ok: true };
    }

    if (intent === "toggleCarrierService") {
      const enable = formData.get("enable") === "true";

      if (enable) {
        const appUrl = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
        const callbackUrl = `${appUrl}/carrier/rates/${doc.carrierService!.token}`;
        const response = await admin.graphql(
          `#graphql
            mutation CreateColisGoCarrierService($input: DeliveryCarrierServiceCreateInput!) {
              carrierServiceCreate(input: $input) {
                carrierService { id name callbackUrl }
                userErrors { field message }
              }
            }`,
          {
            variables: {
              input: {
                name: "ColisGo",
                callbackUrl,
                active: true,
                supportsServiceDiscovery: true,
              },
            },
          },
        );
        const json = await response.json();
        const result = json?.data?.carrierServiceCreate;
        if (result?.userErrors?.length) {
          return { intent, ok: false, error: result.userErrors.map((e: { message: string }) => e.message).join(", ") };
        }
        doc.carrierService!.enabled = true;
        doc.carrierService!.shopifyCarrierServiceId = result?.carrierService?.id || null;
        await doc.save();
        return { intent, ok: true };
      }

      if (doc.carrierService!.shopifyCarrierServiceId) {
        await admin.graphql(
          `#graphql
            mutation DeleteColisGoCarrierService($id: ID!) {
              carrierServiceDelete(id: $id) {
                deletedId
                userErrors { field message }
              }
            }`,
          { variables: { id: doc.carrierService!.shopifyCarrierServiceId } },
        );
      }
      doc.carrierService!.enabled = false;
      doc.carrierService!.shopifyCarrierServiceId = null;
      await doc.save();
      return { intent, ok: true };
    }

    return { intent, ok: false, error: "Action inconnue." };
  } catch (error) {
    return {
      intent,
      ok: false,
      error: error instanceof Error ? error.message : "Erreur inattendue.",
    };
  }
};

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const isSubmitting = navigation.state === "submitting";

  useEffect(() => {
    if (!actionData) return;
    if (actionData.ok) {
      shopify.toast.show("Enregistré");
    } else if (actionData.error) {
      shopify.toast.show(actionData.error, { isError: true });
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Réglages ColisGo">
      {data.status !== "active" && (
        <s-banner tone="warning" heading="Configuration incomplète">
          <s-paragraph>
            Renseignez votre clé API ColisGo et l&apos;adresse de ramassage pour activer les
            expéditions automatiques.
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Identifiants ColisGo">
        <s-paragraph>
          Créez une clé API depuis votre tableau de bord ColisGo Business
          (Intégrations &gt; Clés API). Utilisez une clé <code>sk_test_</code>{" "}
          pour tester, puis <code>sk_live_</code> en production.
        </s-paragraph>
        <Form method="post">
          <input type="hidden" name="intent" value="saveCredentials" />
          <s-stack direction="block" gap="base">
            <s-text-field
              name="apiKey"
              label="Clé API ColisGo"
              placeholder="sk_test_..."
              details={
                data.colisgo.hasApiKey
                  ? `Clé actuelle : mode ${data.colisgo.mode}, se terminant par ${data.colisgo.apiKeyLastFour}`
                  : "Aucune clé enregistrée"
              }
            />
            <s-text-field
              name="webhookSecret"
              label="Secret webhook ColisGo (whsec_...)"
              placeholder="whsec_..."
              details={
                data.colisgo.hasWebhookSecret
                  ? `Secret actuel se terminant par ${data.colisgo.webhookSecretLastFour}`
                  : "Facultatif à cette étape, requis pour recevoir le suivi en temps réel (voir ci-dessous)"
              }
            />
            <s-button type="submit" variant="primary" {...(isSubmitting ? { loading: true } : {})}>
              Enregistrer les identifiants
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Webhook entrant ColisGo">
        <s-paragraph>
          Dans votre tableau de bord ColisGo (Intégrations &gt; Webhooks), créez un webhook
          pointant vers l&apos;URL ci-dessous et cochez au minimum : shipment.assigned,
          tracking.updated, shipment.delivered, shipment.cancelled. Collez ensuite le secret
          généré par ColisGo dans le champ « Secret webhook » ci-dessus.
        </s-paragraph>
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <code>{data.inboundWebhookUrl}</code>
        </s-box>
      </s-section>

      <s-section heading="Adresse de ramassage">
        <Form method="post">
          <input type="hidden" name="intent" value="savePickupLocation" />
          <s-stack direction="block" gap="base">
            <s-text-field name="companyName" label="Nom du magasin" defaultValue={data.pickupLocation?.companyName || ""} />
            <s-text-field name="address" label="Adresse" required defaultValue={data.pickupLocation?.address || ""} />
            <s-text-field name="city" label="Ville" required defaultValue={data.pickupLocation?.city || ""} />
            <s-text-field name="province" label="Province" defaultValue={data.pickupLocation?.province || ""} />
            <s-text-field name="postalCode" label="Code postal" required defaultValue={data.pickupLocation?.postalCode || ""} />
            <s-text-field name="country" label="Pays (ISO 2 lettres)" defaultValue={data.pickupLocation?.country || "CA"} />
            <s-text-field name="phone" label="Téléphone" defaultValue={data.pickupLocation?.phone || ""} />
            <s-button type="submit" {...(isSubmitting ? { loading: true } : {})}>
              Enregistrer l&apos;adresse
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Colis par défaut">
        <s-paragraph>
          Utilisé quand une commande n&apos;a pas de poids exploitable. Le poids réel de la
          commande (somme des articles) est utilisé quand il est disponible.
        </s-paragraph>
        <Form method="post">
          <input type="hidden" name="intent" value="saveDefaults" />
          <s-stack direction="block" gap="base">
            <s-number-field name="weight" label="Poids par défaut (kg)" value={String(data.defaultPackage?.weight ?? 1)} />
            <s-select name="category" label="Catégorie" value={data.defaultPackage?.category || "other"}>
              <s-option value="documents">Documents</s-option>
              <s-option value="clothing">Vêtements</s-option>
              <s-option value="electronics">Électronique</s-option>
              <s-option value="food">Alimentaire</s-option>
              <s-option value="fragile">Fragile</s-option>
              <s-option value="hazardous">Matières dangereuses</s-option>
              <s-option value="other">Autre</s-option>
            </s-select>
            <s-number-field name="declaredValue" label="Valeur déclarée par défaut (CAD)" value={String(data.defaultPackage?.declaredValue ?? 50)} />
            <s-checkbox name="isFragile" label="Fragile par défaut" defaultChecked={Boolean(data.defaultPackage?.isFragile)} />

            <s-select name="triggerEvent" label="Créer l'expédition ColisGo quand" value={data.trigger?.event || "orders/paid"}>
              <s-option value="orders/paid">La commande est payée (recommandé)</s-option>
              <s-option value="orders/create">La commande est créée</s-option>
              <s-option value="manual_only">Jamais automatiquement (bouton manuel uniquement)</s-option>
            </s-select>
            <s-checkbox name="autoCreateEnabled" label="Activer la création automatique" defaultChecked={data.trigger?.autoCreateEnabled ?? true} />
            <s-checkbox
              name="autoChargeRequested"
              label="Facturer automatiquement mon compte ColisGo Business à l'acceptation d'un transporteur"
              details="Nécessite une mise à jour du backend ColisGo (voir TODO.md) — en attendant, un paiement manuel reste requis dans le tableau de bord ColisGo."
              defaultChecked={data.billing?.autoChargeRequested ?? true}
            />

            <s-button type="submit" {...(isSubmitting ? { loading: true } : {})}>
              Enregistrer
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Tarifs ColisGo au paiement (Carrier Service)">
        <s-paragraph>
          ⚠️ Nécessite le plan Shopify Advanced (ou supérieur) ou une boutique de développement.
          Sur les plans Basic/Shopify, cette section n&apos;aura aucun effet au checkout.
        </s-paragraph>
        <Form method="post">
          <input type="hidden" name="intent" value="toggleCarrierService" />
          <input type="hidden" name="enable" value={data.carrierService.enabled ? "false" : "true"} />
          <s-stack direction="inline" gap="base">
            <s-button type="submit" variant={data.carrierService.enabled ? "secondary" : "primary"}>
              {data.carrierService.enabled ? "Désactiver" : "Activer"} les tarifs ColisGo au checkout
            </s-button>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}

export const headers = boundary.headers;
