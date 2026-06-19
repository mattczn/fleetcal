/**
 * Driver-app notifications inbox bell.
 *
 * Bell icon (with a red badge showing unacknowledged count) lives in
 * the Schedule tab header. Tap to open a bottom sheet listing every
 * push notification the driver has been sent in the last 48 hours,
 * newest first. Each card shows: nudge type, load # + title, time
 * sent, and whether the driver has acted on it (acked) yet.
 *
 * Purpose: drivers can verify what's been pushed to them in case a
 * notification got dismissed before they could read it. Tapping a
 * card opens the corresponding load detail screen.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, TouchableOpacity, Modal, Pressable, ActivityIndicator, ScrollView,
  Animated, Dimensions, Easing,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Bell, BellOff, Check, X } from "lucide-react-native";
import { railway } from "@/lib/railway";
import { useTheme } from "@/lib/ThemeProvider";
import type { Colors } from "@/lib/theme";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

// Friendly labels per notification kind. Kept in sync with the
// LoadNotificationKind union in packages/types (no direct import to
// avoid cross-package types at the driver runtime).
const KIND_LABEL: Record<string, string> = {
  confirm:          "Confirm load",
  mark_pickup:      "Mark picked up",
  mark_delivery:    "Mark delivered",
  upload_pod:       "Upload POD",
  report_trailer:   "Report trailer",
  upload_handoff:   "Trailer handoff",
  assigned:         "Load assigned",
  reassigned_away:  "Load reassigned",
  load_cancelled:   "Load cancelled",
};

function kindTint(C: Colors): Record<string, { bg: string; fg: string }> {
  return {
    confirm:          { bg: C.blueBg,     fg: C.blueInk },
    mark_pickup:      { bg: C.amberBg,    fg: C.amberInk },
    mark_delivery:    { bg: C.greenBg,    fg: C.greenInk },
    upload_pod:       { bg: C.purpleBg,   fg: C.purpleInk },
    report_trailer:   { bg: C.redBg,      fg: C.redInk },
    upload_handoff:   { bg: C.purpleBg,   fg: C.purpleInk },
    assigned:         { bg: C.blueBg,     fg: C.blueInk },
    reassigned_away:  { bg: C.amberBg,    fg: C.amberInk },
    load_cancelled:   { bg: C.borderSoft, fg: C.t2 },
  };
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 30_000)      return "just now";
  if (diff < 60_000)      return `${Math.round(diff / 1_000)}s ago`;
  if (diff < 3_600_000)   return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000)  return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

interface Props {
  /** "dark" = standard icon on light bg. "light" = white icon for use
   *  on a colored header (Schedule tab's blue bar). Default: dark. */
  tint?: "dark" | "light";
}

// Right-edge panel sizing: leave a small strip of backdrop visible so
// it reads as an overlay (and gives the user an obvious tap-out zone).
// Capped at 380 so it doesn't stretch awkwardly on tablets.
const SCREEN_W = Dimensions.get("window").width;
const PANEL_W  = Math.min(380, Math.round(SCREEN_W * 0.88));

export function NotificationsBell({ tint = "dark" }: Props = {}) {
  const { C, SHADOW, ACCENT } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const iconColorIdle    = tint === "light" ? "rgba(255,255,255,0.8)" : C.t3;
  const iconColorActive  = tint === "light" ? "#ffffff" : C.t1;
  const buttonBg         = tint === "light" ? "rgba(255,255,255,0.12)" : "transparent";
  const buttonBorder     = tint === "light" ? "rgba(255,255,255,0.18)" : "transparent";

  // Background fetch every 2 min while mounted so the badge stays
  // current without forcing the driver to open the panel. 2 min is a
  // deliberate compromise — fast enough that a fresh notification
  // surfaces in roughly one work-cycle, slow enough that dozens of
  // drivers with the app open don't hammer the API.
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["driver-notifications"],
    queryFn:  () => railway.listMyNotifications(),
    refetchInterval: 2 * 60_000,
    staleTime: 60_000,
  });
  const notifications = data?.notifications ?? [];
  const pendingCount = notifications.filter(n => !n.acknowledgedAt).length;

  // Side-panel slide animation: translateX from off-screen-right (PANEL_W)
  // to 0 when opening, reversed when closing. Modal stays mounted during
  // the closing animation via the `mounted` flag so we can animate out
  // before unmounting.
  const slideX = useRef(new Animated.Value(PANEL_W)).current;
  const backdrop = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      Animated.parallel([
        Animated.timing(slideX, {
          toValue: 0,
          duration: 240,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(backdrop, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else if (mounted) {
      Animated.parallel([
        Animated.timing(slideX, {
          toValue: PANEL_W,
          duration: 200,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(backdrop, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Refresh on open so the panel never shows stale data even between
  // polls. Cheap — the endpoint caps at 100 rows over 48h.
  //
  // Also fire mark-viewed so informational pings (assigned /
  // reassigned_away) clear from the red badge — the user has now seen
  // them. Action-required pings (confirm, upload_pod, ...) stay
  // pending until the driver does the actual action server-side. The
  // refetch after mark-viewed makes the cleared state appear in the UI
  // immediately without waiting for the next 30s poll.
  async function handleOpen() {
    setOpen(true);
    try {
      await railway.markNotificationsViewed();
    } catch (err) {
      console.error("[NotificationsBell] mark-viewed:", err);
    }
    void refetch();
  }

  return (
    <>
      <TouchableOpacity
        onPress={handleOpen}
        activeOpacity={0.7}
        accessibilityLabel="Notifications"
        style={{
          position: "relative",
          width: 36, height: 36, borderRadius: 18,
          alignItems: "center", justifyContent: "center",
          backgroundColor: buttonBg,
          borderWidth: tint === "light" ? 1 : 0,
          borderColor: buttonBorder,
        }}
      >
        <Bell size={15} color={pendingCount > 0 ? iconColorActive : iconColorIdle} strokeWidth={2.4} />
        {pendingCount > 0 ? (
          <View style={{
            position: "absolute",
            top: 2, right: 2,
            minWidth: 16, height: 16, paddingHorizontal: 4,
            borderRadius: 8,
            backgroundColor: C.red,
            alignItems: "center", justifyContent: "center",
            borderWidth: 1.5, borderColor: tint === "light" ? "#1a73e8" : C.surface,
          }}>
            <Text style={[txt(800), { fontSize: 9, color: "#ffffff", lineHeight: 11 }]}>
              {pendingCount > 99 ? "99+" : pendingCount}
            </Text>
          </View>
        ) : null}
      </TouchableOpacity>

      <Modal visible={mounted} transparent animationType="none" onRequestClose={() => setOpen(false)} statusBarTranslucent>
        {/* Backdrop — fades in, tap to close. */}
        <Animated.View style={{
          ...StyleSheetAbsoluteFill,
          backgroundColor: "rgba(0,0,0,0.45)",
          opacity: backdrop,
        }}>
          <Pressable onPress={() => setOpen(false)} style={{ flex: 1 }} />
        </Animated.View>

        {/* Right-edge panel — slides in from off-screen-right. */}
        <Animated.View
          style={{
            position: "absolute",
            top: 0, bottom: 0, right: 0,
            width: PANEL_W,
            backgroundColor: C.surface,
            transform: [{ translateX: slideX }],
            shadowColor: "#000",
            shadowOffset: { width: -2, height: 0 },
            shadowOpacity: 0.18,
            shadowRadius: 12,
            elevation: 16,
          }}
        >
          <View style={{ flex: 1, paddingTop: insets.top, paddingBottom: insets.bottom, backgroundColor: C.surface }}>
            {/* Header */}
            <View style={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.surface }}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <Text style={[txt(800), { fontSize: 18, color: C.t1 }]}>Notifications</Text>
                  <Text style={[txt(500), { fontSize: 12, color: C.t3, marginTop: 2 }]}>
                    Last 48 hours
                    {pendingCount > 0 ? ` · ${pendingCount} pending` : ""}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => setOpen(false)} hitSlop={10}>
                  <X size={22} color={C.t3} strokeWidth={2.2} />
                </TouchableOpacity>
              </View>
            </View>

            {/* List */}
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 30 }}>
              {isLoading && notifications.length === 0 ? (
                <View style={{ paddingVertical: 50, alignItems: "center" }}>
                  <ActivityIndicator size="small" color={ACCENT} />
                </View>
              ) : notifications.length === 0 ? (
                <View style={{ paddingVertical: 50, alignItems: "center", paddingHorizontal: 30 }}>
                  <BellOff size={28} color={C.t4} strokeWidth={2} />
                  <Text style={[txt(700), { fontSize: 14, color: C.t2, marginTop: 12, textAlign: "center" }]}>
                    No notifications in the last 48 hours
                  </Text>
                  <Text style={[txt(500), { fontSize: 12, color: C.t4, marginTop: 4, textAlign: "center" }]}>
                    Pings from dispatch will appear here.
                  </Text>
                </View>
              ) : (
                notifications.map((n) => {
                  const kt = kindTint(C)[n.kind] ?? { bg: C.borderSoft, fg: C.t2 };
                  const label = KIND_LABEL[n.kind] ?? n.kind;
                  const acked = !!n.acknowledgedAt;
                  return (
                    <TouchableOpacity
                      key={n.id}
                      onPress={() => {
                        setOpen(false);
                        // Open the load detail this nudge was for.
                        if (n.eventId) router.push(`/load/${n.eventId}`);
                      }}
                      activeOpacity={0.7}
                      style={{
                        paddingHorizontal: 18,
                        paddingVertical: 14,
                        borderBottomWidth: 1,
                        borderBottomColor: C.borderSoft,
                        borderLeftWidth: acked ? 0 : 3,
                        borderLeftColor: acked ? "transparent" : C.red,
                        backgroundColor: acked ? C.surface : C.surface2,
                      }}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
                        <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: kt.bg }}>
                          <Text style={[txt(800), { fontSize: 10, color: kt.fg, letterSpacing: 0.5 }]}>
                            {label.toUpperCase()}
                          </Text>
                        </View>
                        {acked ? (
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                            <Check size={11} color={C.green} strokeWidth={2.6} />
                            <Text style={[txt(700), { fontSize: 10, color: C.green }]}>Acknowledged</Text>
                          </View>
                        ) : null}
                        <Text style={[txt(500), { fontSize: 11, color: C.t4, marginLeft: "auto" }]}>
                          {relativeTime(n.sentAt)}
                        </Text>
                      </View>
                      <Text style={[txt(700), { fontSize: 14, color: C.t1 }]} numberOfLines={1}>
                        {n.loadNum ? `#${n.loadNum}` : ""}
                        {n.loadNum && n.loadTitle ? " · " : ""}
                        {n.loadTitle ?? (n.loadNum ? "" : "Load")}
                      </Text>
                      <Text style={[txt(500), { fontSize: 11, color: C.t3, marginTop: 2 }]}>
                        Sent by {n.sentByName || "dispatch"}
                      </Text>
                    </TouchableOpacity>
                  );
                })
              )}
            </ScrollView>
          </View>
        </Animated.View>
      </Modal>
    </>
  );
}

// Helper — avoids importing StyleSheet just for absoluteFill.
const StyleSheetAbsoluteFill = {
  position: "absolute" as const,
  top: 0, left: 0, right: 0, bottom: 0,
};
