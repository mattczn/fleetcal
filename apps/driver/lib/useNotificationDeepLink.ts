import { useEffect } from "react";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";

/**
 * Listen for notification taps and deep-link into the relevant screen.
 * Push payloads from the dispatch server include `data.url` (e.g. "/load/<id>").
 * Also handles the "tapped from a cold start" case via getLastNotificationResponseAsync.
 */
export function useNotificationDeepLink() {
  const router = useRouter();

  useEffect(() => {
    function handle(url: unknown) {
      if (typeof url !== "string" || !url.startsWith("/")) return;
      router.push(url as never);
    }

    // App was opened by tapping a notification (cold start)
    Notifications.getLastNotificationResponseAsync().then((res) => {
      handle(res?.notification.request.content.data?.url);
    });

    // App is already running and user taps a notification
    const sub = Notifications.addNotificationResponseReceivedListener((res) => {
      handle(res.notification.request.content.data?.url);
    });
    return () => sub.remove();
  }, [router]);
}
