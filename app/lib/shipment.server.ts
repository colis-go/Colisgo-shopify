import { decryptSecret } from "./crypto.server";
import {
  ColisGoApiError,
  cancelShipment,
  createShipment,
  requestAutoBilling,
  type ColisGoLocation,
  type ColisGoPackageDetails,
} from "./colisgo-client.server";
import { buildAddressQuery, geocodeAddress } from "./geocoder.server";
import ShipmentLog from "../models/ShipmentLog.server";
import type { ShopifyShopDocument } from "../models/ShopifyShop.server";

// Minimal shape we need out of a Shopify order, whether it comes from the
// orders/paid webhook payload (REST-ish JSON) or from an Admin GraphQL
// query (the manual "Send to ColisGo" admin action) — callers normalize
// into this before calling createColisGoShipmentForOrder.
export interface NormalizedOrder {
  id: string; // Shopify order GID, e.g. gid://shopify/Order/123
  legacyResourceId: string; // numeric id, used to build externalOrderId
  name: string; // e.g. "#1001"
  email: string | null;
  phone: string | null;
  currency: string;
  totalPrice: number;
  totalWeightGrams: number;
  shippingAddress: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    provinceCode: string | null;
    country: string | null;
    countryCode: string | null;
    zip: string | null;
    phone: string | null;
    name: string | null;
  } | null;
}

type ShopDoc = ShopifyShopDocument & { _id: unknown };

const MAX_DECLARED_VALUE = 5000; // ColisGo partner API hard cap, see partners.js

export class ShipmentCreationError extends Error {}

function buildExternalOrderId(shop: ShopDoc, order: NormalizedOrder) {
  return `shopify-${order.legacyResourceId}`;
}

async function resolveDeliveryLocation(
  order: NormalizedOrder,
): Promise<ColisGoLocation> {
  const address = order.shippingAddress;
  if (!address || !address.city || !address.zip) {
    throw new ShipmentCreationError(
      "Order has no usable shipping address (missing city or postal code) — cannot create a ColisGo shipment.",
    );
  }

  const query = buildAddressQuery({
    address1: address.address1,
    city: address.city,
    province: address.provinceCode || address.province,
    postalCode: address.zip,
    country: address.countryCode || address.country,
  });
  const geocoded = await geocodeAddress(query);
  if (!geocoded) {
    throw new ShipmentCreationError(
      `Could not geocode delivery address: "${query}"`,
    );
  }

  return {
    address: address.address1 || address.city,
    city: address.city,
    province: address.provinceCode || address.province || null,
    country: (address.countryCode || "CA").toUpperCase().slice(0, 2),
    postalCode: address.zip,
    coordinates: geocoded.coordinates,
  };
}

function resolvePickupLocation(shop: ShopDoc): ColisGoLocation {
  const pickup = shop.pickupLocation;
  if (!pickup?.coordinates || pickup.coordinates.length !== 2) {
    throw new ShipmentCreationError(
      "Store pickup address is not configured yet — set it in the ColisGo app settings first.",
    );
  }

  return {
    address: pickup.address || "",
    city: pickup.city || "",
    province: pickup.province || null,
    country: (pickup.country || "CA").toUpperCase().slice(0, 2),
    postalCode: pickup.postalCode || "",
    coordinates: pickup.coordinates as [number, number],
  };
}

function resolvePackageDetails(
  shop: ShopDoc,
  order: NormalizedOrder,
): ColisGoPackageDetails {
  const weightFromOrder = order.totalWeightGrams
    ? Math.round((order.totalWeightGrams / 1000) * 100) / 100
    : 0;

  return {
    weight: Math.max(weightFromOrder || shop.defaultPackage?.weight || 1, 0.1),
    category: shop.defaultPackage?.category || "other",
    declaredValue: Math.min(
      Math.max(order.totalPrice || shop.defaultPackage?.declaredValue || 50, 1),
      MAX_DECLARED_VALUE,
    ),
    isFragile: Boolean(shop.defaultPackage?.isFragile),
    description: `Shopify order ${order.name}`,
  };
}

export async function createColisGoShipmentForOrder(
  shop: ShopDoc,
  order: NormalizedOrder,
  source: "webhook" | "manual_action",
) {
  const existing = await ShipmentLog.findOne({
    shop: shop.shop,
    shopifyOrderId: order.id,
  });
  if (existing && existing.colisgoShipmentId) {
    return existing;
  }

  if (!shop.colisgo?.apiKeyCiphertext) {
    throw new ShipmentCreationError(
      "ColisGo is not connected for this shop yet — finish setup in the app settings page.",
    );
  }
  if (!order.email || !order.phone) {
    throw new ShipmentCreationError(
      "Order is missing a receiver email or phone number, both are required by the ColisGo partner API.",
    );
  }

  const apiKey = decryptSecret(shop.colisgo.apiKeyCiphertext);
  const externalOrderId = buildExternalOrderId(shop, order);

  const [pickupLocation, deliveryLocation] = await Promise.all([
    Promise.resolve(resolvePickupLocation(shop)),
    resolveDeliveryLocation(order),
  ]);
  const packageDetails = resolvePackageDetails(shop, order);

  let colisgoShipment;
  try {
    colisgoShipment = await createShipment(apiKey, {
      externalOrderId,
      externalShipmentId: order.id,
      source: "shopify",
      pickupLocation,
      deliveryLocation,
      packageDetails,
      receiver: { email: order.email, phone: order.phone },
      metadata: { shopifyOrderName: order.name, shop: shop.shop },
    });
  } catch (error) {
    if (
      error instanceof ColisGoApiError &&
      error.code === "PARTNER_DUPLICATE_EXTERNAL_ORDER"
    ) {
      // Webhook fired twice (Shopify's "at least once" delivery) — this is
      // expected, not a failure. Re-fetch isn't strictly necessary since the
      // log upsert below is idempotent on (shop, shopifyOrderId).
      throw error;
    }
    throw error;
  }

  const autoChargeStatus = await attemptAutoBilling(
    apiKey,
    colisgoShipment.shipmentId,
  );

  const log = await ShipmentLog.findOneAndUpdate(
    { shop: shop.shop, shopifyOrderId: order.id },
    {
      shop: shop.shop,
      shopifyOrderId: order.id,
      shopifyOrderName: order.name,
      externalOrderId,
      colisgoShipmentId: colisgoShipment.shipmentId,
      colisgoStatus: colisgoShipment.status,
      colisgoMode: colisgoShipment.mode,
      trackingUrl: colisgoShipment.trackingUrl,
      pricing: {
        travelerAmount: colisgoShipment.pricing?.travelerAmount ?? null,
        serviceFee: colisgoShipment.pricing?.serviceFee ?? null,
        totalAmount: colisgoShipment.pricing?.totalAmount ?? null,
        currency: colisgoShipment.pricing?.currency ?? "CAD",
      },
      billing: autoChargeStatus,
      source,
      $push: {
        events: {
          type: "shipment_created",
          message: `Created via ${source}`,
          createdAt: new Date(),
        },
      },
    },
    { upsert: true, new: true },
  );

  return log;
}

export async function cancelColisGoShipmentForOrder(
  shop: ShopDoc,
  shopifyOrderId: string,
  reason: string,
) {
  const log = await ShipmentLog.findOne({ shop: shop.shop, shopifyOrderId });
  if (!log || !log.colisgoShipmentId) return null;
  if (log.colisgoStatus === "cancelled") return log;

  if (!shop.colisgo?.apiKeyCiphertext) {
    throw new ShipmentCreationError("ColisGo API key missing, cannot cancel remotely");
  }
  const apiKey = decryptSecret(shop.colisgo.apiKeyCiphertext);

  try {
    const cancelled = await cancelShipment(apiKey, log.colisgoShipmentId, reason);
    log.colisgoStatus = cancelled.status;
  } catch (error) {
    if (error instanceof ColisGoApiError && error.code === "PARTNER_SHIPMENT_ALREADY_ACTIVE") {
      // A carrier already accepted / picked up — ColisGo refuses the
      // cancellation. Surface this so the merchant can sort it out manually
      // instead of silently leaving Shopify and ColisGo out of sync.
      log.events.push({
        type: "cancel_rejected",
        message: "ColisGo refused cancellation: shipment already active with a carrier",
        createdAt: new Date(),
      });
      await log.save();
      throw error;
    }
    throw error;
  }

  log.events.push({ type: "shipment_cancelled", message: reason, createdAt: new Date() });
  await log.save();
  return log;
}

async function attemptAutoBilling(apiKey: string, shipmentId: string) {
  try {
    const result = await requestAutoBilling(apiKey, shipmentId);
    if (result === null) {
      // Endpoint not implemented on the backend yet — see TODO.md.
      return { autoChargeAttempted: true, autoChargeStatus: "not_supported" as const };
    }
    return { autoChargeAttempted: true, autoChargeStatus: "pending" as const };
  } catch (error) {
    return {
      autoChargeAttempted: true,
      autoChargeStatus: "failed" as const,
      lastError: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
