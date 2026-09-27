Voici le parcours complet, étape par étape. Je ne peux pas créer le compte à ta place (ça se passe dans ton navigateur avec ton email), donc commence par l'étape 1, puis dis-moi quand c'est fait et j'enchaîne avec toi sur la liaison technique du projet.

Étape 1 — Créer le compte Partner (dans ton navigateur)
Va sur https://partners.shopify.com/signup
Remplis le formulaire — pour le type d'activité, choisis quelque chose comme "Je crée des apps ou des thèmes" (ça n'a pas d'incidence technique, juste informatif pour Shopify).
Vérifie ton email.
C'est gratuit, aucune carte bancaire requise.
Étape 2 — Créer une boutique de développement
Une fois dans le Partner Dashboard :

Stores (menu de gauche) → Add store
Choisis Create development store
Objectif de la boutique : "Test an app or theme" (pas besoin de données Shopify Payments pour tester ColisGo)
Donne-lui un nom, ex. colisgo-dev
Attends ~1 minute que Shopify la provisionne
Cette boutique est celle sur laquelle tu vas installer et tester l'app ColisGo.

Étape 3 — Lier le projet local à une app Partner
Une fois les étapes 1 et 2 faites, reviens me voir et je lance avec toi, depuis Colisgo for shopify/colisgo-shopify :


npm run config:link
Ça va ouvrir ton navigateur pour te connecter à ton compte Partner, te demander l'organisation, puis proposer de créer une nouvelle app à partir du shopify.app.toml déjà présent (nom "ColisGo"). Ça remplit automatiquement le client_id.

Étape 4 — Compléter les secrets propres à ColisGo
Ces valeurs-là, Shopify ne les connaît pas — il faut les renseigner à la main dans .env (copié depuis .env.example) : MONGODB_URL, APP_ENCRYPTION_KEY (commande de génération déjà dans le fichier), MAPBOX_ACCESS_TOKEN. La clé ColisGo sk_test_... n'est pas nécessaire ici — elle se saisit plus tard directement dans l'écran Réglages de l'app une fois installée.

Étape 5 — Lancer le mode développement

npm run dev
Le CLI te demande sur quelle boutique de dev installer l'app (celle de l'étape 2), ouvre un tunnel HTTPS automatiquement, et installe l'app — tu n'as qu'à approuver les scopes demandés dans le navigateur.

