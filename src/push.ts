import { execSync } from 'child_process';
import webpush from 'web-push';
import { VAPID_EMAIL, VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY } from './config.js';
import {
  deletePushSubscription,
  getAllPushSubscriptions,
  initPushSubscriptionsTable,
} from './db.js';
import { logger } from './logger.js';

let initialized = false;

export async function initPushService(): Promise<void> {
  await initPushSubscriptionsTable();
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    logger.warn('Web Push: VAPID keys not set — push notifications disabled');
    return;
  }
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  initialized = true;
  logger.info('Web Push service initialized');
}

export async function sendPushNotification(payload: {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}): Promise<void> {
  // macOS native notification via osascript (always fires, no setup required)
  try {
    const safe = payload.body.replace(/"/g, '\\"').slice(0, 100);
    const title = payload.title.replace(/"/g, '\\"');
    execSync(
      `osascript -e 'display notification "${safe}" with title "${title}"'`,
      { timeout: 2000 },
    );
  } catch {
    /* non-critical */
  }

  // Web Push to all registered browser/PWA clients
  if (!initialized) return;

  const subscriptions = await getAllPushSubscriptions();
  if (subscriptions.length === 0) return;

  const data = JSON.stringify(payload);
  const results = await Promise.allSettled(
    subscriptions.map((sub) =>
      webpush
        .sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          data,
          { TTL: 60 },
        )
        .catch(async (err: { statusCode?: number }) => {
          if (err.statusCode === 410 || err.statusCode === 404) {
            // Subscription expired — clean up
            await deletePushSubscription(sub.endpoint);
            logger.info(
              { endpoint: sub.endpoint.slice(-20) },
              'Push: removed expired subscription',
            );
          } else {
            throw err;
          }
        }),
    ),
  );

  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    logger.warn(
      { failed, total: subscriptions.length },
      'Push: some notifications failed',
    );
  }
}
