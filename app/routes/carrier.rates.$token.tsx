import type { ActionFunctionArgs } from "react-router";

import ShopifyShop from "../models/ShopifyShop.server";
import { decryptSecret } from "../lib/crypto.server";
import { quoteShipment } from "../lib/colisgo-client.server";
import { buildAddressQuery, geocodeAddress } from "../lib/geocoder.server";

// Shopify's Carrier Service callback. Not a Shopify-authenticated route: the
// per-shop `token` in the URL is what scopes the request (see
// ShopifyShop.carrierService.token, generated in app.settings.tsx). Shopify
// caches and times out this callback aggressively (~2-3s) — every failure
// path below responds fast with `rates: []` so checkout still works instead
// of erroring out for the customer.
interface CarrierRateRequest {
  rate: {
    origin: { country: string; postal_code: string; province?: string; city: string; address1?: string };
    destination: { country: string; postal_code: string; province?: string; city: string; address1?: string; name?: string };
    items: Array<{ name: string; quantity: number; grams: number; price: number }>;
    currency: string;
    locale?: string;
  };
}

const EMPTY_RATES = { rates: [] };

function addDaysIso(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 19).replace("T", " ") + " +0000";
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json(EMPTY_RATES, { status: 405 });
  }

  try {
    const shop = await ShopifyShop.findOne({
      "carrierService.token": params.token,
      "carrierService.enabled": true,
      status: "active",
    });
    if (!shop?.colisgo?.apiKeyCiphertext || !shop.pickupLocation?.coordinates) {
      return Response.json(EMPTY_RATES);
    }

    const body = (await request.json()) as CarrierRateRequest;
    const destination = body?.rate?.destination;
    if (!destination?.city || !destination?.postal_code) {
      return Response.json(EMPTY_RATES);
    }

    const destinationQuery = buildAddressQuery({
      address1: destination.address1,
      city: destination.city,
      province: destination.province,
      postalCode: destination.postal_code,
      country: destination.country,
    });
    const geocoded = await geocodeAddress(destinationQuery);
    if (!geocoded) {
      return Response.json(EMPTY_RATES);
    }

    const items = body.rate.items || [];
    const weightKg = Math.max(
      items.reduce((sum, item) => sum + (item.grams || 0) * (item.quantity || 1), 0) / 1000,
      0.1,
    );
    const declaredValue = Math.min(
      Math.max(
        items.reduce((sum, item) => sum + ((item.price || 0) * (item.quantity || 1)) / 100, 0),
        1,
      ),
      5000,
    );

    const apiKey = decryptSecret(shop.colisgo.apiKeyCiphertext);
    const quote = await quoteShipment(apiKey, {
      pickupLocation: {
        address: shop.pickupLocation.address || "",
        city: shop.pickupLocation.city || "",
        province: shop.pickupLocation.province || null,
        country: (shop.pickupLocation.country || "CA").toUpperCase().slice(0, 2),
        postalCode: shop.pickupLocation.postalCode || "",
        coordinates: shop.pickupLocation.coordinates as [number, number],
      },
      deliveryLocation: {
        address: destination.address1 || destination.city,
        city: destination.city,
        province: destination.province || null,
        country: (destination.country || "CA").toUpperCase().slice(0, 2),
        postalCode: destination.postal_code,
        coordinates: geocoded.coordinates,
      },
      packageDetails: {
        weight: Math.round(weightKg * 100) / 100,
        category: shop.defaultPackage?.category || "other",
        declaredValue: Math.round(declaredValue * 100) / 100,
        isFragile: Boolean(shop.defaultPackage?.isFragile),
      },
    });

    return Response.json({
      rates: [
        {
          service_name: "ColisGo — Livraison collaborative",
          service_code: "colisgo",
          total_price: String(Math.round(quote.pricing.totalAmount * 100)),
          currency: quote.pricing.currency,
          description: "Livraison estimée par ColisGo",
          min_delivery_date: addDaysIso(1),
          max_delivery_date: addDaysIso(3),
        },
      ],
    });
  } catch {
    // Any error (timeout, ColisGo down, bad payload): fail open with no
    // rate rather than breaking checkout for the customer.
    return Response.json(EMPTY_RATES);
  }
};
