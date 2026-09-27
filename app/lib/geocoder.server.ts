/**
 * Forward geocoding via Mapbox — the same provider the core ColisGo backend
 * uses (services/user-service/services/userService.js). No Nominatim
 * fallback: nothing in the current ColisGo backend relies on one, so we're
 * not assuming it works for our SLA (Nominatim's public instance is slow
 * and rate-limited, a poor fit for the ~2s carrier-rate budget anyway).
 *
 * Only the checkout *destination* is geocoded at request time; the store's
 * pickup location is geocoded once when the merchant saves settings and
 * cached on the ShopifyShop document.
 */

interface GeocodeResult {
  coordinates: [number, number]; // [lng, lat]
}

const cache = new Map<string, { value: GeocodeResult | null; expiresAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = Number(process.env.MAPBOX_TIMEOUT_MS || 1800);

function cacheKey(query: string) {
  return query.trim().toLowerCase();
}

function readCache(key: string): GeocodeResult | null | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

export async function geocodeAddress(
  query: string,
): Promise<GeocodeResult | null> {
  const token = process.env.MAPBOX_ACCESS_TOKEN;
  if (!token) {
    throw new Error("MAPBOX_ACCESS_TOKEN is not set");
  }

  const key = cacheKey(query);
  const cached = readCache(key);
  if (cached !== undefined) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = new URL(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`,
    );
    url.searchParams.set("access_token", token);
    url.searchParams.set("limit", "1");

    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      cache.set(key, { value: null, expiresAt: Date.now() + CACHE_TTL_MS });
      return null;
    }

    const json = (await response.json()) as {
      features?: Array<{ center?: [number, number] }>;
    };
    const center = json.features?.[0]?.center;
    const result: GeocodeResult | null = center
      ? { coordinates: [center[0], center[1]] }
      : null;

    cache.set(key, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } catch {
    // Timeout or network error: don't cache failures for the full TTL, a
    // retry a few requests later should be allowed to succeed.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function buildAddressQuery(parts: {
  address1?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  country?: string | null;
}): string {
  return [parts.address1, parts.city, parts.province, parts.postalCode, parts.country]
    .filter(Boolean)
    .join(", ");
}
