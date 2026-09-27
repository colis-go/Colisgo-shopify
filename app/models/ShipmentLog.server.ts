import mongoose, { Schema, type InferSchemaType } from "mongoose";

import "../db.server";

/**
 * Local audit trail mapping a Shopify order to the ColisGo shipment created
 * for it. Needed regardless of backend changes: it's what makes webhook
 * processing idempotent (a Shopify webhook can fire more than once) and
 * what lets the dashboard/order extension show ColisGo status without
 * re-querying ColisGo on every page load.
 */
const ShipmentLogSchema = new Schema(
  {
    shop: { type: String, required: true, index: true },

    shopifyOrderId: { type: String, required: true, index: true },
    shopifyOrderName: { type: String, default: null },
    shopifyFulfillmentId: { type: String, default: null },

    externalOrderId: { type: String, required: true },
    colisgoShipmentId: { type: String, default: null },
    colisgoStatus: { type: String, default: null },
    colisgoMode: { type: String, enum: ["test", "live"], default: "test" },
    trackingUrl: { type: String, default: null },

    pricing: {
      travelerAmount: { type: Number, default: null },
      serviceFee: { type: Number, default: null },
      totalAmount: { type: Number, default: null },
      currency: { type: String, default: "CAD" },
    },

    billing: {
      autoChargeAttempted: { type: Boolean, default: false },
      // "not_supported" until the backend ships automatic business billing
      // (see TODO.md). Kept as its own status so the UI can explain the
      // pending manual-payment step to the merchant instead of looking
      // broken.
      autoChargeStatus: {
        type: String,
        enum: ["not_supported", "pending", "succeeded", "failed"],
        default: "not_supported",
      },
      lastError: { type: String, default: null },
    },

    source: {
      type: String,
      enum: ["webhook", "manual_action"],
      default: "webhook",
    },

    events: [
      {
        type: {
          type: String,
          required: true,
        },
        message: { type: String, default: null },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);

ShipmentLogSchema.index({ shop: 1, shopifyOrderId: 1 }, { unique: true });

export type ShipmentLogDocument = InferSchemaType<typeof ShipmentLogSchema>;

const ShipmentLog =
  (mongoose.models.ShipmentLog as mongoose.Model<ShipmentLogDocument>) ||
  mongoose.model<ShipmentLogDocument>("ShipmentLog", ShipmentLogSchema);

export default ShipmentLog;
