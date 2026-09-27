import mongoose, { Schema, type InferSchemaType } from "mongoose";

import "../db.server";

/**
 * One document per installed shop. This is the "new dedicated model" the
 * Shopify app owns for its own persistence — separate from the core ColisGo
 * backend's `Business.integrationPlugins` catalog (which stays a generic,
 * unstructured stub). Secrets are stored encrypted (see lib/crypto.server.ts),
 * never in plain text.
 */
const ShopifyShopSchema = new Schema(
  {
    shop: { type: String, required: true, unique: true, index: true },

    installedAt: { type: Date, default: Date.now },
    uninstalledAt: { type: Date, default: null },

    status: {
      type: String,
      enum: ["onboarding", "active", "needs_attention", "disabled"],
      default: "onboarding",
    },

    // ColisGo partner credentials, pasted by the merchant from their
    // ColisGo business dashboard (Integrations > API keys).
    colisgo: {
      mode: { type: String, enum: ["test", "live"], default: "test" },
      apiKeyCiphertext: { type: String, default: null },
      apiKeyLastFour: { type: String, default: null },
      // Raw webhook signing secret (whsec_...) created by the merchant in
      // their ColisGo dashboard and pointed at this shop's inbound webhook
      // URL (see inboundWebhookToken below).
      webhookSecretCiphertext: { type: String, default: null },
      webhookSecretLastFour: { type: String, default: null },
      lastVerifiedAt: { type: Date, default: null },
      lastVerificationError: { type: String, default: null },
    },

    pickupLocation: {
      companyName: { type: String, default: null },
      address: { type: String, default: null },
      city: { type: String, default: null },
      province: { type: String, default: null },
      country: { type: String, default: "CA" },
      postalCode: { type: String, default: null },
      phone: { type: String, default: null },
      coordinates: { type: [Number], default: null }, // [lng, lat]
      geocodedAt: { type: Date, default: null },
    },

    defaultPackage: {
      weight: { type: Number, default: 1 },
      category: {
        type: String,
        enum: [
          "documents",
          "clothing",
          "electronics",
          "food",
          "fragile",
          "hazardous",
          "other",
        ],
        default: "other",
      },
      declaredValue: { type: Number, default: 50 },
      isFragile: { type: Boolean, default: false },
    },

    trigger: {
      // Which Shopify order webhook creates the ColisGo shipment.
      event: {
        type: String,
        enum: ["orders/paid", "orders/create", "manual_only"],
        default: "orders/paid",
      },
      autoCreateEnabled: { type: Boolean, default: true },
    },

    billing: {
      // Merchant's intent: charge the ColisGo business account automatically
      // once a carrier accepts, instead of paying manually in the ColisGo
      // dashboard. Actually charging requires backend support that does not
      // exist yet — see TODO.md ("Facturation automatique business").
      autoChargeRequested: { type: Boolean, default: true },
    },

    carrierService: {
      enabled: { type: Boolean, default: false },
      shopifyCarrierServiceId: { type: String, default: null },
      // Unguessable per-shop path segment used in the callback URL
      // (/carrier/rates/:token) since Shopify's carrier-service POST body
      // does not identify the shop.
      token: { type: String, required: true, index: true },
      currency: { type: String, default: "CAD" },
    },

    // Unguessable per-shop path segment for inbound ColisGo webhooks
    // (/webhooks/colisgo/:token), same reasoning as carrierService.token.
    inboundWebhookToken: { type: String, required: true, index: true },

    uninstallReason: { type: String, default: null },
  },
  { timestamps: true },
);

export type ShopifyShopDocument = InferSchemaType<typeof ShopifyShopSchema>;

const ShopifyShop =
  (mongoose.models.ShopifyShop as mongoose.Model<ShopifyShopDocument>) ||
  mongoose.model<ShopifyShopDocument>("ShopifyShop", ShopifyShopSchema);

export default ShopifyShop;
