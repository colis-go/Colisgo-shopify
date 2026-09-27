# ColisGo pour Shopify

Application Shopify (React Router 7 / admin embarqué) qui relie une boutique
Shopify au réseau de livraison collaboratif ColisGo : elle affiche un tarif
ColisGo au checkout, crée une expédition ColisGo à prix fixe lorsqu'une
commande est payée, et répercute le suivi ColisGo sur la commande Shopify.

Construite à partir du template officiel `shopify-app-template-react-router`,
en suivant l'architecture arrêtée dans [`../shopify.md`](../shopify.md) :

- **Distribution :** fiche publique sur le Shopify App Store, également
  installable par les clients entreprise ColisGo existants (pas de build
  « custom app » distinct).
- **Mode d'intégration :** piloté par webhooks (`orders/paid` → création de
  l'expédition → `fulfillmentCreateV2`), et non l'option plus lourde
  Fulfillment Service.
- **Persistance :** une base MongoDB dédiée (`colisgo_shopify`, sur le même
  cluster que le backend principal) avec deux collections propres à cette
  app — `ShopifyShop` (identifiants ColisGo et réglages par boutique) et
  `ShipmentLog` (piste d'audit commande ⇄ expédition ⇄ traitement) — plus le
  stockage de session de Shopify via l'adaptateur MongoDB officiel. Rien
  n'est écrit dans la base du backend ColisGo principal.
- **Facturation :** l'écran de réglages propose une préférence de
  « prélèvement automatique », mais ColisGo ne dispose pas encore d'un
  endpoint permettant de débiter automatiquement un compte entreprise —
  voir **[TODO.md](./TODO.md)**, qui recense toutes les évolutions backend
  nécessaires à cette app. Le backend ColisGo principal n'a
  **délibérément pas été modifié** pendant la construction de cette app.

## Structure du projet

```
app/
  shopify.server.ts        # OAuth, stockage de session MongoDB
  models/
    ShopifyShop.server.ts  # identifiants ColisGo + réglages par boutique
    ShipmentLog.server.ts  # piste d'audit commande ⇄ expédition ⇄ traitement
  lib/
    crypto.server.ts       # chiffrement au repos AES-256-GCM des secrets
    colisgo-client.server.ts  # client de l'API partenaire ColisGo
    geocoder.server.ts     # géocodage Mapbox, cache à TTL court
    colisgo-webhook.server.ts # vérifie les signatures HMAC entrantes de ColisGo
    shipment.server.ts     # logique partagée de création/annulation d'expédition
    fulfillment.server.ts  # appels GraphQL de traitement + suivi Shopify
  routes/
    app._index.tsx           # tableau de bord
    app.settings.tsx         # identifiants ColisGo, adresse de ramassage, défauts
    carrier.rates.$token.tsx # callback Carrier Service (tarifs au checkout)
    webhooks.orders.paid.tsx | orders.cancelled.tsx | refunds.create.tsx
    webhooks.colisgo.$token.tsx     # webhook ColisGo entrant (suivi, etc.)
    webhooks.customers.*.tsx, webhooks.shop.redact.tsx  # RGPD obligatoires
    api.orders.$id.send-to-colisgo.tsx  # backend de l'action admin ci-dessous
extensions/
  send-to-colisgo/          # action admin « Envoyer à ColisGo » sur la commande
```

## Installation locale

1. `npm install`
2. `shopify app config link` — rattache cette configuration à une app de ton
   Partner dashboard (remplit le `client_id` dans `shopify.app.toml`).
3. Copier `.env.example` vers `.env` et le compléter :
   - `MONGODB_URL` / `MONGODB_DB_NAME` — pointer vers une instance MongoDB
     (une instance locale convient en développement ; utiliser une base
     `colisgo_shopify_dev`, surtout pas celle de production).
   - `APP_ENCRYPTION_KEY` — à générer avec
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
   - `MAPBOX_ACCESS_TOKEN` — même compte Mapbox que le backend ColisGo
     principal.
   - Une clé d'API ColisGo **sandbox** (`sk_test_...`) issue d'un compte
     entreprise ColisGo, créée depuis Intégrations → Clés API dans le
     tableau de bord ColisGo.
4. `npm run dev` — le CLI Shopify t'authentifie, ouvre un tunnel et installe
   l'app sur une boutique de développement.
5. Dans l'écran Réglages de l'app, coller la clé `sk_test_...`, renseigner
   une adresse de ramassage et, optionnellement, activer les tarifs au
   checkout — ce qui suppose que la boutique de développement soit sur une
   formule compatible avec le Carrier Service (toutes les boutiques de
   développement le sont).

## Checklist de tests (à faire avant de se fier à quoi que ce soit)

Rien de tout ceci n'a été exécuté contre une boutique Shopify réelle ni une
clé sandbox ColisGo réelle dans cet environnement — construis, mais vérifie
avant de livrer :

- [ ] L'installation OAuth aboutit et l'app embarquée se charge.
- [ ] Écran Réglages : l'enregistrement des identifiants valide bien la clé
      auprès de ColisGo ; l'enregistrement de l'adresse de ramassage la
      géocode correctement ; l'activation/désactivation du carrier service
      l'enregistre/le supprime réellement (`carrierServiceCreate` /
      `carrierServiceDelete`).
- [ ] Un checkout sur une boutique de développement (éligible au Carrier
      Service) affiche le tarif ColisGo ; la réponse reste dans le délai
      imparti par Shopify, même avec un cache Mapbox froid.
- [ ] Passer et payer une commande de test → `orders/paid` se déclenche →
      une entrée apparaît dans `ShipmentLog` → un traitement Shopify avec le
      suivi ColisGo apparaît sur la commande.
- [ ] Annuler / rembourser une commande pas encore ramassée → l'expédition
      ColisGo et le traitement Shopify sont tous deux annulés.
- [ ] Action admin « Envoyer à ColisGo » sur une page commande : vérification
      du statut à l'ouverture, le clic crée l'expédition, une réouverture
      affiche « déjà envoyée ». Surveiller les problèmes de CORS/preflight
      sur le fetch cross-origin depuis l'extension (voir le commentaire dans
      `api.orders.$id.send-to-colisgo.tsx`).
- [ ] Déclencher un webhook ColisGo sandbox (`tracking.updated`,
      `shipment.delivered`) sur `/webhooks/colisgo/:token` avec une vraie
      signature HMAC et confirmer que le traitement Shopify se met à jour.
- [ ] `shopify app deploy` réussit et les trois webhooks RGPD apparaissent
      bien comme enregistrés dans le Partner dashboard.

## Déploiement

Voir [`../shopify.md`](../shopify.md) §14 pour le plan de déploiement
VPS Hostinger + Nginx + PM2 + MongoDB (sous-domaine `app.colisgo.ca`,
processus PM2 distinct de l'API principale et du site vitrine).

## Ce qui n'est délibérément pas encore construit

Voir **[TODO.md](./TODO.md)** pour la liste complète des évolutions backend
ColisGo que cette app attend (prélèvement automatique des comptes
entreprise, enregistrement des webhooks en libre-service, support
multi-devises, etc.) — aucun de ces travaux backend n'a été touché pendant
la construction de cette app, conformément aux consignes.
