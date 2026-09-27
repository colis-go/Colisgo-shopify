/**
 * Thin client for the ColisGo E-commerce Partner API
 * (docs/ecommerce-partner-api.md in the core ColisGo backend repo, plus the
 * /shipments/quote endpoint which exists in
 * services/announcement-service/routes/partners.js but is not yet
 * documented there — see TODO.md item "Documenter /shipments/quote").
 *
 * All calls are server-side only. The API key never reaches the browser.
 */

const BASE_URL = (
  process.env.COLISGO_API_BASE_URL || "https://colisgo.cloud/api/partners"
).replace(/\/$/, "");

// Shopify's Carrier Service callback times out aggressively (~a few
// seconds); keep our own outbound call budget well under that.
const QUOTE_TIMEOUT_MS = Number(process.env.COLISGO_QUOTE_TIMEOUT_MS || 2200);
const DEFAULT_TIMEOUT_MS = Number(process.env.COLISGO_API_TIMEOUT_MS || 8000);

export interface ColisGoLocation {
  address: string;
  city: string;
  province?: string | null;
  country: string;
  postalCode: string;
  coordinates: [number, number]; // [lng, lat]
}

export interface ColisGoPackageDetails {
  weight: number;
  dimensions?: { length?: number; width?: number; height?: number };
  category:
    | "documents"
    | "clothing"
    | "electronics"
    | "food"
    | "fragile"
    | "hazardous"
    | "other";
  declaredValue: number;
  isFragile?: boolean;
  description?: string;
  photos?: string[];
}

export interface ColisGoReceiver {
  email: string;
  phone: string;
}

export interface ColisGoPricing {
  currency: string;
  travelerAmount: number;
  platformServiceFee: number;
  serviceFee: number;
  totalAmount: number;
  commissionPercentage: number;
}

export interface ColisGoShipment {
  id: string;
  shipmentId: string;
  externalOrderId: string | null;
  externalShipmentId: string | null;
  status: string;
  mode: "test" | "live";
  isTest: boolean;
  pricingMode: string;
  isNegotiable: boolean;
  proposedPrice: number | null;
  currency: string;
  pricing: ColisGoPricing;
  trackingUrl: string;
  booking: null | {
    id: string;
    bookingNumber: string;
    status: string;
    paymentStatus: string;
    agreedPrice: number;
    totalAmount: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface CreateShipmentInput {
  externalOrderId: string;
  externalShipmentId?: string;
  source?: string;
  pickupLocation: ColisGoLocation;
  deliveryLocation: ColisGoLocation;
  packageDetails: ColisGoPackageDetails;
  receiver: ColisGoReceiver;
  proposedPrice?: number;
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface QuoteInput {
  pickupLocation: ColisGoLocation;
  deliveryLocation: ColisGoLocation;
  packageDetails: ColisGoPackageDetails;
  proposedPrice?: number;
}

export interface QuoteResult {
  pricing: ColisGoPricing;
  proposedPrice: number;
  currency: string;
  priceSource: "estimator" | "partner";
}

export class ColisGoApiError extends Error {
  code?: string;
  status: number;
  details?: string[];

  constructor(
    message: string,
    status: number,
    code?: string,
    details?: string[],
  ) {
    super(message);
    this.name = "ColisGoApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const json = await response.json().catch(() => null);

    if (!response.ok || !json?.success) {
      throw new ColisGoApiError(
        json?.error || `ColisGo API error (HTTP ${response.status})`,
        response.status,
        json?.code,
        json?.details,
      );
    }

    return json.data as T;
  } finally {
    clearTimeout(timer);
  }
}

export function quoteShipment(apiKey: string, input: QuoteInput) {
  return request<QuoteResult>(
    apiKey,
    "POST",
    "/shipments/quote",
    input,
    QUOTE_TIMEOUT_MS,
  );
}

export function createShipment(apiKey: string, input: CreateShipmentInput) {
  return request<ColisGoShipment>(apiKey, "POST", "/shipments", input);
}

export function getShipment(apiKey: string, idOrExternalReference: string) {
  return request<ColisGoShipment>(
    apiKey,
    "GET",
    `/shipments/${encodeURIComponent(idOrExternalReference)}`,
  );
}

export function listShipments(
  apiKey: string,
  params: { limit?: number; status?: string; externalOrderId?: string } = {},
) {
  const query = new URLSearchParams();
  if (params.limit) query.set("limit", String(params.limit));
  if (params.status) query.set("status", params.status);
  if (params.externalOrderId)
    query.set("externalOrderId", params.externalOrderId);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return request<ColisGoShipment[]>(apiKey, "GET", `/shipments${suffix}`);
}

export function cancelShipment(
  apiKey: string,
  idOrExternalReference: string,
  reason?: string,
) {
  return request<ColisGoShipment>(
    apiKey,
    "POST",
    `/shipments/${encodeURIComponent(idOrExternalReference)}/cancel`,
    { reason },
  );
}

/**
 * Requests automatic business billing for a shipment once a carrier
 * accepts it, instead of the merchant paying manually in the ColisGo
 * dashboard. THIS ENDPOINT DOES NOT EXIST YET on the ColisGo backend — see
 * TODO.md ("Facturation automatique business"). Calling it will 404 until
 * that work ships; callers must treat that as "not supported yet", not as
 * a hard failure.
 */
export async function requestAutoBilling(
  apiKey: string,
  shipmentId: string,
): Promise<{ status: "requested" } | null> {
  try {
    return await request<{ status: "requested" }>(
      apiKey,
      "POST",
      `/shipments/${encodeURIComponent(shipmentId)}/billing/auto-charge`,
    );
  } catch (error) {
    if (error instanceof ColisGoApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}
