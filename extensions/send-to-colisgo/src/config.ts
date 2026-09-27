// Admin UI extensions run in a sandboxed iframe on admin.shopify.com — they
// have no access to the app's server-side env vars, so the backend's public
// URL has to be a literal here. Keep this in sync with `application_url` in
// shopify.app.toml and the SHOPIFY_APP_URL env var whenever either changes.
export const APP_URL = "https://app.colisgo.ca";
