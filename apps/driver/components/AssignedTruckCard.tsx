/**
 * AssignedTruckCard — shown at the top of the load detail screen while
 * the load is still pre-pickup (status === "scheduled"). Surfaces the
 * truck the driver is supposed to be using PLUS quick actions to
 * locate it: "View on Map" scrolls to the existing route map; "Navigate"
 * opens the device's default maps app with directions to the truck's
 * last-known coordinates.
 *
 * Includes a disclaimer that dispatch may have reassigned the asset
 * or the GPS may be stale — same warning ops gives over the phone, so
 * the driver isn't surprised when the actual truck differs from what
 * the card says.
 */

import React, { useState } from "react";
import { View, Text, TouchableOpacity, Linking, Platform, ActionSheetIOS, Alert, ActivityIndicator } from "react-native";
import { Truck, MapPin, Navigation, AlertTriangle, RefreshCw } from "lucide-react-native";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

/** Human-readable "5m ago" / "2h ago" / "yesterday" style. Falls back
 *  to the raw ISO if anything goes wrong. */
function relTime(iso: string | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 60_000)      return "just now";
  if (diff < 3_600_000)   return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000)  return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

interface Props {
  assetName: string;
  /** Color the swatch + truck icon take. Defaults to brand blue if
   *  the asset has no color set (shouldn't normally happen). */
  assetColor?: string | null;
  /** Live position. When undefined or null the Navigate button is
   *  disabled and a "no location yet" hint replaces the description. */
  truck?: {
    lat:          number;
    lon:          number;
    locatedAt:    string;
    description?: string;
  } | null;
  /** Fires when "View on Map" is tapped — caller scrolls/expands the
   *  existing route map into view. */
  onViewOnMap: () => void;
  /** Force-refresh the truck location (bypass the per-org Motive
   *  cache server-side). Caller should return a promise that
   *  resolves once the new data is in. Card displays a spinner on
   *  the refresh button while it's pending. Omit to hide the
   *  refresh affordance entirely. */
  onRefresh?: () => Promise<void>;
}

export function AssignedTruckCard({ assetName, assetColor, truck, onViewOnMap, onRefresh }: Props) {
  const color = assetColor ?? "#1a73e8";
  const hasLocation = truck != null;
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try { await onRefresh(); }
    finally { setRefreshing(false); }
  }

  /** Picks between Google Maps and Apple Maps. On iOS we surface a
   *  native action sheet; Android shows an Alert with the same two
   *  options (Apple Maps obviously won't install but the URL scheme
   *  is still a valid option label — left out for Android). */
  const handleNavigate = () => {
    if (!hasLocation) return;
    const dest = `${truck.lat},${truck.lon}`;
    const googleUrl = `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
    // Apple Maps uses ?daddr=lat,lng for driving directions. Falls
    // through to mobile Safari's Apple Maps fallback on iPhone, and
    // opens Apple Maps app if installed.
    const appleUrl  = `https://maps.apple.com/?daddr=${dest}&dirflg=d`;

    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title:               "Navigate to truck",
          options:             ["Google Maps", "Apple Maps", "Cancel"],
          cancelButtonIndex:   2,
          userInterfaceStyle:  "light",
        },
        (idx) => {
          if (idx === 0) void Linking.openURL(googleUrl);
          if (idx === 1) void Linking.openURL(appleUrl);
        },
      );
      return;
    }
    // Android — no Apple Maps but keep parity by offering the choice.
    // Apple Maps URL on Android opens in browser (still usable).
    Alert.alert(
      "Navigate to truck",
      "Open in which app?",
      [
        { text: "Google Maps", onPress: () => void Linking.openURL(googleUrl) },
        { text: "Apple Maps",  onPress: () => void Linking.openURL(appleUrl) },
        { text: "Cancel", style: "cancel" },
      ],
    );
  };

  return (
    <View style={{
      backgroundColor: "#ffffff",
      borderRadius: 14,
      padding: 14,
      marginBottom: 14,
      borderWidth: 1,
      borderColor: "#e8eaed",
      shadowColor: "#000",
      shadowOpacity: 0.04,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
    }}>
      {/* Header row: color swatch + truck icon + name */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{
          width: 40, height: 40, borderRadius: 10,
          backgroundColor: color,
          alignItems: "center", justifyContent: "center",
          flexShrink: 0,
        }}>
          <Truck size={20} color="#ffffff" strokeWidth={2.4} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[txt(500), { fontSize: 11, color: "#5f6368", textTransform: "uppercase", letterSpacing: 0.6 }]}>
            Assigned Truck
          </Text>
          <Text style={[txt(800), { fontSize: 16, color: "#202124", marginTop: 1 }]} numberOfLines={1}>
            {assetName}
          </Text>
        </View>
      </View>

      {/* Last-seen line + refresh button. Truck location ages with the
          truck (engine off → ping doesn't update), so the driver may
          need to force-fetch from Motive when the timestamp looks too
          old. Spinner replaces the icon while the refetch is in flight. */}
      <View style={{ marginTop: 10, paddingLeft: 52, flexDirection: "row", alignItems: "center" }}>
        {hasLocation ? (
          <Text style={[txt(500), { flex: 1, fontSize: 12, color: "#5f6368" }]} numberOfLines={1}>
            <MapPin size={11} color="#5f6368" strokeWidth={2.2} />{" "}
            {truck.description?.trim() || "Location available"}
            <Text style={[txt(500), { color: "#9aa0a6" }]}>{"  ·  "}{relTime(truck.locatedAt)}</Text>
          </Text>
        ) : (
          <Text style={[txt(500), { flex: 1, fontSize: 12, color: "#9aa0a6" }]}>
            No live location available
          </Text>
        )}
        {onRefresh && (
          <TouchableOpacity
            onPress={() => void handleRefresh()}
            disabled={refreshing}
            hitSlop={10}
            style={{
              width: 28, height: 28, borderRadius: 14,
              alignItems: "center", justifyContent: "center",
              opacity: refreshing ? 0.5 : 1,
            }}
            accessibilityLabel="Refresh truck location"
          >
            {refreshing
              ? <ActivityIndicator size="small" color="#5f6368" />
              : <RefreshCw size={14} color="#5f6368" strokeWidth={2.2} />}
          </TouchableOpacity>
        )}
      </View>

      {/* Action row */}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 14 }}>
        <TouchableOpacity
          onPress={onViewOnMap}
          activeOpacity={0.85}
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            paddingVertical: 10,
            borderRadius: 10,
            backgroundColor: "#e8f0fe",
          }}
        >
          <MapPin size={14} color="#1a73e8" strokeWidth={2.4} />
          <Text style={[txt(700), { fontSize: 13, color: "#1a73e8" }]}>View on Map</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleNavigate}
          activeOpacity={0.85}
          disabled={!hasLocation}
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            paddingVertical: 10,
            borderRadius: 10,
            backgroundColor: hasLocation ? "#0f9d58" : "#f1f3f4",
          }}
        >
          <Navigation size={14} color={hasLocation ? "#ffffff" : "#9aa0a6"} strokeWidth={2.4} />
          <Text style={[txt(700), { fontSize: 13, color: hasLocation ? "#ffffff" : "#9aa0a6" }]}>
            Navigate
          </Text>
        </TouchableOpacity>
      </View>

      {/* Disclaimer */}
      <View style={{
        marginTop: 12,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 6,
        backgroundColor: "#fffbf0",
        borderRadius: 8,
        padding: 9,
      }}>
        <AlertTriangle size={12} color="#a16207" strokeWidth={2.2} style={{ marginTop: 1 }} />
        <Text style={[txt(500), { flex: 1, fontSize: 11, color: "#854d0e", lineHeight: 16 }]}>
          Truck and location may have changed. Double-check with dispatch before leaving for the truck.
        </Text>
      </View>
    </View>
  );
}
