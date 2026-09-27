import { useEffect, useState } from "react";
import {
  reactExtension,
  useApi,
  AdminAction,
  BlockStack,
  Button,
  Text,
  Banner,
} from "@shopify/ui-extensions-react/admin";

import { APP_URL } from "./config";

const TARGET = "admin.order-details.action.render";

export default reactExtension(TARGET, () => <SendToColisGo />);

interface StatusResponse {
  alreadySent: boolean;
  trackingUrl: string | null;
  status: string | null;
}

function SendToColisGo() {
  const { data, auth, close } = useApi(TARGET);
  const orderId = data?.selected?.[0]?.id;

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadStatus() {
      if (!orderId) return;
      try {
        const token = await auth.idToken();
        const legacyId = orderId.split("/").pop();
        const response = await fetch(`${APP_URL}/api/orders/${legacyId}/send-to-colisgo`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) {
          setStatus(await response.json());
        }
      } catch {
        // Silently fall back to the "send" button — the action itself will
        // surface a clearer error if something is actually wrong.
      } finally {
        setLoading(false);
      }
    }
    loadStatus();
  }, [orderId, auth]);

  async function handleSend() {
    if (!orderId) return;
    setSending(true);
    setError(null);
    try {
      const token = await auth.idToken();
      const legacyId = orderId.split("/").pop();
      const response = await fetch(`${APP_URL}/api/orders/${legacyId}/send-to-colisgo`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await response.json();
      if (!response.ok || !json.ok) {
        setError(json.error || "Échec de l'envoi à ColisGo.");
        return;
      }
      setStatus({ alreadySent: true, trackingUrl: json.trackingUrl, status: null });
    } catch {
      setError("Impossible de joindre l'app ColisGo.");
    } finally {
      setSending(false);
    }
  }

  return (
    <AdminAction
      title="Envoyer à ColisGo"
      primaryAction={
        !loading && !status?.alreadySent ? (
          <Button onPress={handleSend} disabled={sending}>
            {sending ? "Envoi..." : "Envoyer à ColisGo"}
          </Button>
        ) : (
          <Button onPress={close}>Fermer</Button>
        )
      }
      secondaryAction={<Button onPress={close}>Annuler</Button>}
    >
      <BlockStack gap="base">
        {loading && <Text>Vérification du statut ColisGo…</Text>}

        {!loading && status?.alreadySent && (
          <Banner tone="success">
            Cette commande a déjà été envoyée à ColisGo.
          </Banner>
        )}

        {!loading && !status?.alreadySent && (
          <Text>
            Crée une expédition ColisGo à prix fixe pour cette commande, avec l&apos;adresse
            et le colis par défaut configurés dans les réglages de l&apos;app.
          </Text>
        )}

        {error && <Banner tone="critical">{error}</Banner>}
      </BlockStack>
    </AdminAction>
  );
}
