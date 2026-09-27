# ColisGo for Shopify — Build Guide

This guide explains how to rebuild the **ColisGo for WooCommerce** plugin as a **Shopify app**. It maps every feature of the WooCommerce plugin to its Shopify equivalent, then walks through the architecture, APIs, and App Store requirements.

> **Read this first — the big conceptual shift.**
> A WooCommerce plugin is PHP files you drop into `wp-content/plugins/` and they run *inside* the merchant's WordPress. **A Shopify app is not installed on the store.** It is a **web service you host yourself** (Node.js), that the store talks to over HTTPS via OAuth, webhooks, and the GraphQL Admin API. You cannot "upload a folder" — you must deploy and operate a server (or serverless functions) 24/7. Budget for hosting.
>
> **API note (2025+):** New public apps must use the **GraphQL Admin API** — the REST Admin API is legacy. All examples below use GraphQL.

---

## 1. Feature mapping: WooCommerce → Shopify

| ColisGo WooCommerce feature | Shopify mechanism |
|---|---|
| Auto-create shipment when order hits a status | Subscribe to `orders/paid` (or `orders/fulfilled`) webhook, or register as a **Fulfillment Service** and receive `fulfillment_orders/fulfillment_request_submitted` |
| Manual "Send to ColisGo" button on an order | **Admin action/block extension** on the order details page (App Bridge), calling your app backend |
| Auto-cancel shipment on cancel/refund | Webhooks `orders/cancelled`, `refunds/create`; then call ColisGo cancel + `fulfillmentCancel` |
| Checkout shipping method with an estimated rate | **Carrier Service API** — a callback URL Shopify POSTs at checkout to fetch live rates |
| Incoming ColisGo webhooks + HMAC verification | Your app exposes its own endpoints for ColisGo; Shopify's *own* webhooks are HMAC-verified separately |
| Order status update on delivery + tracking notes | `fulfillmentCreateV2` / `fulfillmentTrackingInfoUpdate` mutations |
| Customer-facing tracking panel | Tracking URL attached to the fulfillment (shown on order status page & customer account) + optional **order status page UI extension** |
| ColisGo column in orders list | Not directly possible; surface data via order **metafields** + an admin block on the order page |
| HPOS support | N/A — Shopify manages order storage |
| Sandbox (`sk_test_`) / production (`sk_live_`) keys | App settings stored in your DB or shop **metafields**; same ColisGo keys |
| Settings page under WooCommerce menu | **Embedded admin page** (Polaris + App Bridge) inside Shopify admin |
| Geocoding via Mapbox / Nominatim | Same — server-side calls from your app backend |

---

## 2. Prerequisites

- A **Shopify Partner account** (free): https://partners.shopify.com
- A **development store** (created from the Partner dashboard) to install and test.
- **Node.js 20+** and **npm**.
- **Shopify CLI** (installed automatically via `npm`, or globally).
- A place to **host** the app backend (Fly.io, Render, Railway, Vercel, a VPS, etc.) with a public HTTPS URL for production. For local dev the CLI creates a tunnel automatically.
- Your **ColisGo partner API key** and **webhook secret** (same as the WooCommerce plugin).
- ⚠️ **Carrier-calculated shipping requires the merchant to be on the Advanced Shopify plan or higher** (or a yearly plan, or a dev store). Merchants on Basic/Shopify plans cannot use the Carrier Service API. Plan for this limitation or offer a flat-rate fallback.

---

## 3. Scaffold the app

The recommended template today is **React Router 7** (successor to the Remix template), which ships with OAuth, session storage (Prisma/SQLite by default — we swap this for MongoDB, see §14.3), Polaris Web Components, and App Bridge wired up.

```bash
# Create the app
npm init @shopify/app@latest
# or, to pick the template explicitly:
shopify app init --template=https://github.com/Shopify/shopify-app-template-react-router

cd colisgo-shopify

# Run locally — CLI logs you in, creates a tunnel, and installs on your dev store
shopify app dev
```

Key files in the template:
- `shopify.app.toml` — app config: name, scopes, webhooks, app URL.
- `app/shopify.server.ts` — the `@shopify/shopify-app-react-router` setup (auth, API version, session storage → point at MongoDB here).
- `app/routes/app.tsx` — embedded admin shell (App Bridge + Polaris).
- `app/routes/app._index.tsx` — your settings/dashboard page.
- session + your own data → **MongoDB** (see §14.3); the default `prisma/schema.prisma` is removed.

---

## 4. Access scopes

Set these in `shopify.app.toml` (`[access_scopes]`) — request the minimum you need:

```toml
[access_scopes]
scopes = "write_shipping,write_fulfillments,read_assigned_fulfillment_orders,write_assigned_fulfillment_orders,read_orders,write_orders,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders"
```

- `write_shipping` — required to register the Carrier Service (checkout rates).
- `write_fulfillments`, `read/write_assigned_fulfillment_orders` — required to act as a fulfillment service and create fulfillments/tracking.
- `read_orders` / `write_orders` — read order data, write metafields/notes.

---

## 5. Store configuration (the "settings page")

Two options for persisting the merchant's ColisGo config (API key, webhook secret, store address, Mapbox token, default weight/category, trigger status):

1. **Your app database** (MongoDB — reusing ColisGo's cluster) keyed by shop domain — simplest, keeps secrets off the store. **Recommended for secrets.**
2. **Shop metafields** — good for non-secret config you want visible in Shopify.

Build the settings UI as an embedded page with **Polaris** components. Save via a route action that writes to Prisma. Never expose the ColisGo API key to the browser — keep all ColisGo calls server-side.

---

## 6. Checkout rates — Carrier Service API

This replaces the WooCommerce `ColisGo_Shipping_Method` + `/shipments/quote` quote.

### 6.1 Register the carrier service (once per install, after OAuth)

GraphQL mutation `carrierServiceCreate`:

```graphql
mutation {
  carrierServiceCreate(input: {
    name: "ColisGo",
    callbackUrl: "https://your-app.example.com/carrier/rates",
    active: true,
    supportsServiceDiscovery: true
  }) {
    carrierService { id name callbackUrl }
    userErrors { field message }
  }
}
```

### 6.2 Respond to Shopify's rate request

Shopify **POSTs** to your `callbackUrl` at checkout. Request body:

```json
{
  "rate": {
    "origin":      { "country": "CA", "postal_code": "K2P1L4", "province": "ON", "city": "Ottawa", "address1": "150 Elgin St." },
    "destination": { "country": "CA", "postal_code": "K1M1M4", "province": "ON", "city": "Ottawa", "address1": "24 Sussex Dr.", "name": "Bob Norman" },
    "items": [
      { "name": "T-Shirt", "quantity": 1, "grams": 1000, "price": 1999, "requires_shipping": true, "product_id": 48447225880, "variant_id": 258644705304 }
    ],
    "currency": "CAD",
    "locale": "en"
  }
}
```

Your endpoint geocodes origin/destination (Mapbox → Nominatim fallback), calls the ColisGo `/shipments/quote` endpoint, and returns a `rates` array. **`total_price` is in cents (subunits).**

```json
{
  "rates": [
    {
      "service_name": "ColisGo — Livraison collaborative",
      "service_code": "colisgo",
      "total_price": "1295",
      "currency": "CAD",
      "description": "Livraison estimée par ColisGo",
      "min_delivery_date": "2026-07-20 09:00:00 -0400",
      "max_delivery_date": "2026-07-22 18:00:00 -0400"
    }
  ]
}
```

> Shopify caches and times out these callbacks aggressively (respond in ~2–3 s). Keep geocoding results cached; return an empty `rates: []` if ColisGo can't quote, so checkout still works.

---

## 7. Shipment creation & tracking — Fulfillment Service API

This replaces `ColisGo_Shipment::create()` and the tracking notes. There are two integration styles:

**A. Webhook-driven (simpler).** Subscribe to `orders/paid` (or your chosen trigger). On receipt, call the ColisGo `/api/partners/shipments` endpoint, then create a fulfillment with tracking. Good analog to the WooCommerce "auto-create on status."

**B. Fulfillment Service (deeper integration).** Register the app as a fulfillment service so Shopify routes fulfillment orders to you. Choose this if ColisGo should own the fulfillment location.

### 7.1 Register as a fulfillment service (option B)

```graphql
mutation {
  fulfillmentServiceCreate(
    name: "ColisGo",
    callbackUrl: "https://your-app.example.com/fulfillment",
    trackingSupport: true,
    inventoryManagement: false
  ) {
    fulfillmentService { id location { id } }
    userErrors { field message }
  }
}
```

Shopify then sends `FULFILLMENT_REQUEST` / `CANCELLATION_REQUEST` notifications to `callbackUrl/fulfillment_order_notification`. Your app:
1. Reads the request via the `assignedFulfillmentOrders` query.
2. Accepts with `fulfillmentOrderAcceptFulfillmentRequest` (or rejects).
3. Calls ColisGo to create the shipment.
4. Creates the fulfillment + tracking with `fulfillmentCreateV2`.

### 7.2 Create the fulfillment with tracking (both options)

```graphql
mutation CreateFulfillment($fulfillment: FulfillmentV2Input!) {
  fulfillmentCreateV2(fulfillment: $fulfillment) {
    fulfillment { id status trackingInfo { number url } }
    userErrors { field message }
  }
}
```

Update tracking later (e.g. from a ColisGo `tracking.updated` webhook) with `fulfillmentTrackingInfoUpdate`.

### 7.3 Cancellation (replaces auto-cancel on refund/cancel)

- Webhooks: `orders/cancelled`, `refunds/create`.
- Call ColisGo cancel, then `fulfillmentCancel` (and, under option B, `fulfillmentOrderAcceptCancellationRequest`).

---

## 8. Webhooks

### 8.1 Shopify → your app

Declare in `shopify.app.toml`:

```toml
[[webhooks.subscriptions]]
topics = ["orders/paid", "orders/cancelled", "refunds/create", "fulfillment_orders/fulfillment_request_submitted", "fulfillment_orders/cancellation_request_submitted"]
uri = "/webhooks"
```

**Verify every Shopify webhook** with HMAC (the framework's `authenticate.webhook` does this for you). Raw pattern:

```
digest = Base64( HMAC-SHA256( rawBody, SHOPIFY_API_SECRET ) )
verify digest === header "X-Shopify-Hmac-Sha256"
```

### 8.2 ColisGo → your app

Keep the ColisGo incoming webhooks (`shipment.assigned`, `tracking.updated`, `shipment.delivered`, `shipment.cancelled`) exactly as in the WooCommerce plugin, verifying the ColisGo HMAC signature with the merchant's webhook secret. On `tracking.updated`/`delivered`, call `fulfillmentTrackingInfoUpdate` / mark the fulfillment delivered.

### 8.3 Mandatory GDPR/privacy webhooks (App Store requirement)

Every public app **must** implement these three, or it will fail review:

- `customers/data_request`
- `customers/redact`
- `shop/redact`

---

## 9. Manual "Send to ColisGo" action

Recreate the manual button with an **Admin UI extension** (order details action/block). It renders inside the order page and calls your app backend, which runs the same shipment-creation code path as the webhook. Scaffold with:

```bash
shopify app generate extension
# choose: Admin action / Admin block
```

---

## 10. Customer tracking

Shopify shows the tracking number + URL from the fulfillment automatically on the **order status page** and in **customer accounts** — no custom panel needed for the basics. For a richer ColisGo-branded status (live map, collaborative-courier status labels), add an **order status / Thank-you page UI extension** that reads an order metafield your app writes.

---

## 11. External services documentation

Same disclosure obligation as WooCommerce. Shopify's App Store review + your app's **privacy policy** must document that the app sends data to: **ColisGo API** (`colisgo.cloud`), **Mapbox** (`api.mapbox.com`), and **OpenStreetMap Nominatim** — what data, when, and links to each service's terms/privacy. Reuse the `== External services ==` text from `readme.txt`.

---

## 12. Billing (if you charge)

If the app is paid, use the **Shopify Billing API** (`appSubscriptionCreate` / usage charges) — you may **not** collect payment outside Shopify for app access. Set up during/after OAuth.

---

## 13. Testing & deployment

- **Local:** `shopify app dev` — tunnel + hot reload on your dev store.
- **Deploy config:** `shopify app deploy` — pushes `shopify.app.toml`, extensions, and webhook subscriptions.
- **Host the web backend** separately (Fly/Render/Railway/VPS). Set env vars: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`, `SHOPIFY_APP_URL`, plus ColisGo/Mapbox config, and a real database (Postgres/MySQL) instead of the default SQLite.
- **Test matrix:** rate at checkout (dev store must be Advanced/dev), order paid → shipment created → tracking shows on order status page, cancel/refund → shipment cancelled, ColisGo webhook → tracking updated.

---

## 14. Hosting on Hostinger (VPS)

The Shopify app is an **always-on Node.js service**, so it needs a **Hostinger VPS or Cloud plan** — *not* shared/Premium/Business web hosting (those are PHP-only, with no persistent Node process or open ports). Since ColisGo already runs Node infrastructure (`colisgo.cloud` API, `colisgo.ca` Next.js site), the app can live alongside it on the same VPS as a **separate service on its own subdomain**.

### 14.1 Plan a subdomain

Use a dedicated subdomain so the app is isolated from the marketing site and the core API:

```
app.colisgo.ca   →  Shopify app (Node, port 3000)
colisgo.ca       →  existing Next.js site
colisgo.cloud    →  existing ColisGo partner API
```

Add a DNS **A record** `app` → your VPS IP (in Hostinger hPanel → DNS, or your DNS provider).

### 14.2 Prepare the VPS

```bash
# As root, on the Hostinger VPS (Ubuntu)
apt update && apt upgrade -y
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs nginx
npm install -g pm2
```

**Database — reuse ColisGo's existing MongoDB.** No new database engine is needed: the app stores Shopify sessions and per-shop config in MongoDB via the official adapter (see §14.3). Point it at your existing cluster (self-hosted MongoDB on the VPS, or MongoDB Atlas) — ideally a **separate database** (e.g. `colisgo_shopify`) so it's isolated from the core app's collections.

### 14.3 Deploy the app

**Use MongoDB for session storage (drop Prisma).** The template defaults to Prisma/SQLite, but the official `@shopify/shopify-app-session-storage-mongodb` adapter lets you reuse ColisGo's MongoDB. In `app/shopify.server.ts`:

```ts
import { MongoDBSessionStorage } from "@shopify/shopify-app-session-storage-mongodb";

const shopify = shopifyApp({
  // ...apiKey, apiSecretKey, scopes, appUrl, etc.
  sessionStorage: new MongoDBSessionStorage(
    process.env.MONGODB_URL,      // e.g. mongodb+srv://user:pass@cluster/
    process.env.MONGODB_DB_NAME,  // e.g. "colisgo_shopify" — db name is a SEPARATE arg, not in the URL
  ),
});
```

Store the merchant's ColisGo config (API key, webhook secret, store address, Mapbox token, defaults) in a normal MongoDB collection via your existing Mongoose/driver connection — the same pattern the core ColisGo app already uses.

```bash
# Pull your code, install, build
cd /var/www
git clone <your-repo> colisgo-shopify && cd colisgo-shopify
npm ci
npm install @shopify/shopify-app-session-storage-mongodb mongodb
npm uninstall @prisma/client prisma            # Prisma no longer needed
rm -rf prisma                                  # remove the Prisma schema/migrations
npm run build
```

Create `/var/www/colisgo-shopify/.env`:

```env
SHOPIFY_API_KEY=xxxxxxxx
SHOPIFY_API_SECRET=xxxxxxxx
SCOPES=write_shipping,write_fulfillments,read_assigned_fulfillment_orders,write_assigned_fulfillment_orders,read_orders,write_orders
SHOPIFY_APP_URL=https://app.colisgo.ca
MONGODB_URL="mongodb+srv://colisgo_app:a-strong-password@your-cluster/"
MONGODB_DB_NAME="colisgo_shopify"
PORT=3000
# ColisGo / Mapbox config as needed
```

Start it under PM2 (auto-restart on crash/reboot):

```bash
pm2 start npm --name colisgo-shopify -- run start
pm2 save
pm2 startup   # run the printed command so it survives reboots
```

### 14.4 Nginx reverse proxy + HTTPS

`/etc/nginx/sites-available/app.colisgo.ca`:

```nginx
server {
    listen 80;
    server_name app.colisgo.ca;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
    }
}
```

```bash
ln -s /etc/nginx/sites-available/app.colisgo.ca /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
# Free TLS certificate
apt install -y certbot python3-certbot-nginx
certbot --nginx -d app.colisgo.ca
```

### 14.5 Point Shopify at the subdomain

In `shopify.app.toml`, set the URLs to the subdomain, then `shopify app deploy`:

```toml
application_url = "https://app.colisgo.ca"

[auth]
redirect_urls = [ "https://app.colisgo.ca/auth/callback", "https://app.colisgo.ca/auth/shopify/callback" ]
```

The carrier-service `callbackUrl` and webhook `uri` values then resolve under `https://app.colisgo.ca/...`.

### 14.6 Operational must-dos

- **Firewall:** open only 80/443 (and SSH). Node stays on `127.0.0.1:3000`, never exposed directly.
- **Uptime is business-critical:** if this server is down, the checkout rate call fails silently (customers won't see the ColisGo option) and webhooks are delayed. Use PM2 auto-restart + a monitor (UptimeRobot/Hostinger monitoring) + alerts.
- **Latency:** the carrier callback must answer in ~2–3 s — cache geocoding results; pick a VPS region close to your customers.
- **Backups:** back up the MySQL database (sessions + per-shop ColisGo config) regularly.
- **Keep it separate:** run it as its own PM2 process/port, distinct from the Next.js site and the core API, so a deploy or crash of one doesn't take down the others.
- **Redeploys:** `git pull && npm ci && npm run build && pm2 restart colisgo-shopify` (MongoDB is schemaless — no migration step).

> A single VPS has no automatic failover. That's acceptable to launch, but if ColisGo scales, consider a load balancer + a second instance, or a managed platform (Fly/Render/Railway), for redundancy.

---

## 15. App Store submission checklist

- ✅ OAuth + embedded app loads in admin, offline & online tokens handled.
- ✅ All three GDPR webhooks implemented and HMAC-verified.
- ✅ Only requested scopes are used.
- ✅ Privacy policy + support contact + clear listing (screenshots, icon 1200×1200, feature list).
- ✅ External services (ColisGo/Mapbox/Nominatim) disclosed.
- ✅ Handles the "not on Advanced plan → no carrier rates" case gracefully.
- ✅ No secrets exposed to the browser; ColisGo key stays server-side.

> **Distribution options:** submit to the public **App Store** (full review), or distribute as a **custom app** to specific merchants (lighter process, no public listing) if ColisGo only serves known partners. A custom app skips App Store review but can't be publicly listed.

---

## 16. Suggested repo layout

```
colisgo-shopify/
├── shopify.app.toml
├── app/
│   ├── shopify.server.ts          # framework + API version + Prisma sessions
│   ├── routes/
│   │   ├── app._index.tsx         # settings/dashboard (Polaris)
│   │   ├── app.settings.tsx       # ColisGo API key, address, Mapbox token
│   │   ├── carrier.rates.tsx      # Carrier Service callback (POST) — checkout quote
│   │   ├── fulfillment.tsx        # Fulfillment service callback (option B)
│   │   └── webhooks.tsx           # Shopify webhooks (orders/*, GDPR)
│   └── lib/
│       ├── colisgo-client.ts      # port of class-colisgo-api-client.php
│       ├── geocoder.ts            # port of class-colisgo-geocoder.php (Mapbox → Nominatim)
│       ├── shipment.ts            # port of class-colisgo-shipment.php
│       └── db.ts                  # MongoDB connection + per-shop config model
└── extensions/
    └── send-to-colisgo/           # admin action ("Send to ColisGo")
# Sessions + per-shop ColisGo config live in MongoDB (no prisma/ folder)
```

Most of the WooCommerce PHP business logic (API client, geocoder, payload building, status mapping) ports almost 1:1 to TypeScript — only the WordPress hooks/settings glue is replaced by Shopify's webhooks, GraphQL mutations, and React Router routes.

---

## 17. References

- Scaffold an app: https://shopify.dev/docs/apps/build/scaffold-app
- React Router app package: https://shopify.dev/docs/api/shopify-app-react-router/latest
- React Router template repo: https://github.com/Shopify/shopify-app-template-react-router
- Carrier Service API: https://shopify.dev/docs/api/admin-rest/latest/resources/carrierservice
- Build for fulfillment services: https://shopify.dev/docs/apps/build/orders-fulfillment/fulfillment-service-apps/build-for-fulfillment-services
- Fulfillment service concepts: https://shopify.dev/docs/apps/build/orders-fulfillment/fulfillment-service-apps
- Admin GraphQL API: https://shopify.dev/docs/api/admin-graphql/latest
- App CLI `app init`: https://shopify.dev/docs/api/shopify-cli/app/app-init
