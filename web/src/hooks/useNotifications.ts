import { useCallback, useEffect, useState } from 'react';

const TOKEN_KEY = 'nanoclaw_token';

function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function useNotifications() {
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default',
  );
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);
  const supported = typeof Notification !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;

  // Check existing subscription on mount
  useEffect(() => {
    if (!supported) return;
    navigator.serviceWorker.ready.then(reg => {
      reg.pushManager.getSubscription().then(sub => {
        setSubscribed(!!sub);
      });
    });
  }, [supported]);

  const subscribe = useCallback(async () => {
    if (!supported || loading) return;
    setLoading(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') { setLoading(false); return; }

      // Get VAPID public key from server
      const token = getToken();
      const vapidRes = await fetch('/api/notifications/vapid-key', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const vapidData = await vapidRes.json();
      if (!vapidData.ok || !vapidData.data?.publicKey) { setLoading(false); return; }

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidData.data.publicKey,
      });

      const subJson = sub.toJSON();
      await fetch('/api/notifications/subscribe', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          endpoint: subJson.endpoint,
          keys: subJson.keys,
        }),
      });

      setSubscribed(true);
    } catch {
      // Permission denied or push setup failed
    }
    setLoading(false);
  }, [supported, loading]);

  return { permission, subscribed, subscribe, loading, supported };
}
