/**
 * Relay trailer-location pin.
 *
 * Rendered alongside the relay handoff photos block on a relay leg's
 * load detail screen. Two modes, gated on relayRole:
 *
 *   pickup leg → "Save Trailer Location" button. Captures device GPS,
 *     POSTs to /v1/driver/events/:id/trailer-dropoff. Once saved, the
 *     button switches to "Update" so the driver can re-pin if they
 *     bumped the trailer to a different spot.
 *
 *   delivery leg → read-only card showing the partner's pin (if the
 *     pickup driver has saved one yet) with Navigate / View on Map
 *     actions, mirroring AssignedTruckCard. If the pickup driver
 *     hasn't pinned yet, shows a "Waiting on pickup driver" hint.
 */

import React, { useState } from "react";
import {
  View, Text, TouchableOpacity, ActivityIndicator, Alert,
  Linking, Platform, ActionSheetIOS,
} from "react-native";
import { MapPin, Navigation, AlertTriangle, Pin, RefreshCw } from "lucide-react-native";
import * as Location from "expo-location";
import { railway } from "@/lib/railway";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

/** "5m ago" / "2h ago" / "yesterday" style. */
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
  eventId:   string;
  relayRole: "pickup" | "delivery";
  /** Own dropoff (rendered + updatable when relayRole='pickup'). */
  trailerDropoffLat?: number;
  trailerDropoffLng?: number;
  trailerDropoffAt?:  string;
  /** Partner's dropoff (rendered when relayRole='delivery'). */
  partnerTrailerDropoffLat?:     number;
  partnerTrailerDropoffLng?:     number;
  partnerTrailerDropoffAt?:      string;
  /** Dispatcher-set address from the relay partner (pickup leg).
   *  Primary location source — shown above the driver's GPS pin. */
  partnerTrailerDropoffAddress?: string;
  /** Fired after a successful save so the parent can refetch the
   *  load and refresh the partner's view in real time. */
  onSaved?: () => void;
}

export function RelayTrailerLocation(props: Props) {
  if (props.relayRole === "pickup") return <PickupView {...props} />;
  return <DeliveryView {...props} />;
}

// ── Pickup-leg view ─────────────────────────────────────────────────
//
// The driver dropping the trailer. They tap a button, we ask for
// location permission once, capture coords, POST to the API.

function PickupView({ eventId, trailerDropoffLat, trailerDropoffLng, trailerDropoffAt, onSaved }: Props) {
  const [saving, setSaving] = useState(false);
  const hasPin = trailerDropoffLat != null && trailerDropoffLng != null;

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== "granted") {
        Alert.alert(
          "Location permission needed",
          "Enable location for Curzon Driver in Settings so we can pin the trailer drop spot.",
        );
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      await railway.saveTrailerDropoff(eventId, {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      });
      onSaved?.();
    } catch (err) {
      Alert.alert("Couldn't save location", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: "#ddd6fe" }}>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
        <Text style={[txt(800), { flex: 1, fontSize: 12, color: "#6b21a8", letterSpacing: 0.4, textTransform: "uppercase" }]}>
          Trailer Location
        </Text>
      </View>

      {hasPin ? (
        <View style={{
          backgroundColor: "#faf5ff", borderRadius: 10, padding: 12, borderWidth: 1, borderColor: "#e9d5ff",
        }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Pin size={14} color="#6b21a8" strokeWidth={2.4} />
            <Text style={[txt(700), { flex: 1, fontSize: 13, color: "#581c87" }]}>
              Saved {relTime(trailerDropoffAt)}
            </Text>
          </View>
          <Text style={[txt(500), { fontSize: 11, color: "#7e22ce", marginTop: 4, paddingLeft: 22 }]}>
            {trailerDropoffLat?.toFixed(5)}, {trailerDropoffLng?.toFixed(5)}
          </Text>
          <TouchableOpacity
            onPress={() => void handleSave()}
            disabled={saving}
            activeOpacity={0.7}
            style={{
              marginTop: 10,
              flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
              paddingVertical: 10,
              borderRadius: 10,
              backgroundColor: "#8b5cf6",
              opacity: saving ? 0.5 : 1,
            }}
          >
            {saving
              ? <ActivityIndicator size="small" color="#ffffff" />
              : <RefreshCw size={13} color="#ffffff" strokeWidth={2.4} />}
            <Text style={[txt(700), { fontSize: 13, color: "#ffffff" }]}>
              Update pin
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          onPress={() => void handleSave()}
          disabled={saving}
          activeOpacity={0.7}
          style={{
            flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
            paddingVertical: 14,
            borderRadius: 10,
            borderWidth: 1.5, borderColor: "#8b5cf6", borderStyle: "dashed",
            backgroundColor: "#faf5ff",
            opacity: saving ? 0.5 : 1,
          }}
        >
          {saving
            ? <ActivityIndicator size="small" color="#6b21a8" />
            : <Pin size={16} color="#6b21a8" strokeWidth={2.2} />}
          <Text style={[txt(700), { fontSize: 13, color: "#6b21a8" }]}>
            {saving ? "Saving…" : "Save trailer location"}
          </Text>
        </TouchableOpacity>
      )}

      <Text style={[txt(500), { fontSize: 11, color: "#7e22ce", marginTop: 8, lineHeight: 16 }]}>
        Tap when you've parked + dropped the trailer. The next driver will see this pin
        when they come to pick it up.
      </Text>
    </View>
  );
}

// ── Delivery-leg view ───────────────────────────────────────────────
//
// The driver coming to pick up the trailer. Shows the partner's pin
// + Navigate + View on Map actions. When the partner hasn't pinned
// yet, shows a 'waiting' hint instead of empty space.

function DeliveryView({ partnerTrailerDropoffLat, partnerTrailerDropoffLng, partnerTrailerDropoffAt, partnerTrailerDropoffAddress }: Props) {
  const hasPin     = partnerTrailerDropoffLat != null && partnerTrailerDropoffLng != null;
  const hasAddress = !!(partnerTrailerDropoffAddress?.trim());

  function handleNavigate() {
    if (!hasPin && !hasAddress) return;
    // Prefer the address-based directions URL when dispatch has set
    // one — it's the source of truth. Fall back to the GPS pin when
    // we only have the driver's coords.
    const googleUrl = hasAddress
      ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(partnerTrailerDropoffAddress!.trim())}`
      : `https://www.google.com/maps/dir/?api=1&destination=${partnerTrailerDropoffLat},${partnerTrailerDropoffLng}`;
    const appleUrl  = hasAddress
      ? `https://maps.apple.com/?daddr=${encodeURIComponent(partnerTrailerDropoffAddress!.trim())}&dirflg=d`
      : `https://maps.apple.com/?daddr=${partnerTrailerDropoffLat},${partnerTrailerDropoffLng}&dirflg=d`;

    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title:              "Navigate to trailer",
          options:            ["Google Maps", "Apple Maps", "Cancel"],
          cancelButtonIndex:  2,
          userInterfaceStyle: "light",
        },
        (idx) => {
          if (idx === 0) void Linking.openURL(googleUrl);
          if (idx === 1) void Linking.openURL(appleUrl);
        },
      );
      return;
    }
    Alert.alert(
      "Navigate to trailer",
      "Open in which app?",
      [
        { text: "Google Maps", onPress: () => void Linking.openURL(googleUrl) },
        { text: "Apple Maps",  onPress: () => void Linking.openURL(appleUrl) },
        { text: "Cancel", style: "cancel" },
      ],
    );
  }

  return (
    <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: "#ddd6fe" }}>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
        <Text style={[txt(800), { flex: 1, fontSize: 12, color: "#6b21a8", letterSpacing: 0.4, textTransform: "uppercase" }]}>
          Trailer Location
        </Text>
      </View>

      {(hasAddress || hasPin) ? (
        <View style={{
          backgroundColor: "#faf5ff", borderRadius: 10, padding: 12, borderWidth: 1, borderColor: "#e9d5ff",
        }}>
          {/* Address — primary source of truth (set by dispatch). */}
          {hasAddress && (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <MapPin size={14} color="#6b21a8" strokeWidth={2.4} />
                <Text style={[txt(700), { flex: 1, fontSize: 13, color: "#581c87" }]}>
                  Drop address
                </Text>
              </View>
              <Text style={[txt(600), { fontSize: 13, color: "#581c87", marginTop: 4, paddingLeft: 22 }]}>
                {partnerTrailerDropoffAddress}
              </Text>
            </>
          )}

          {/* Driver pin — secondary verification layer. Below the
              address when both exist; standalone when no address yet. */}
          {hasPin && (
            <View style={{
              marginTop: hasAddress ? 10 : 0,
              padding: hasAddress ? 8 : 0,
              backgroundColor: hasAddress ? "#f5f3ff" : undefined,
              borderRadius: hasAddress ? 6 : 0,
            }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Pin size={12} color="#6b21a8" strokeWidth={2.4} />
                <Text style={[txt(700), { flex: 1, fontSize: 12, color: "#581c87" }]}>
                  {hasAddress ? "Driver pin" : "Pinned by pickup driver"} · {relTime(partnerTrailerDropoffAt)}
                </Text>
              </View>
              <Text style={[txt(500), { fontSize: 11, color: "#7e22ce", marginTop: 2, paddingLeft: 20 }]}>
                {partnerTrailerDropoffLat?.toFixed(5)}, {partnerTrailerDropoffLng?.toFixed(5)}
              </Text>
            </View>
          )}

          <TouchableOpacity
            onPress={handleNavigate}
            activeOpacity={0.85}
            style={{
              marginTop: 10,
              flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
              paddingVertical: 10,
              borderRadius: 10,
              backgroundColor: "#0f9d58",
            }}
          >
            <Navigation size={14} color="#ffffff" strokeWidth={2.4} />
            <Text style={[txt(700), { fontSize: 13, color: "#ffffff" }]}>
              Navigate to trailer
            </Text>
          </TouchableOpacity>

          {/* Disclaimer — matches the AssignedTruckCard pattern */}
          <View style={{
            marginTop: 10,
            flexDirection: "row",
            alignItems: "flex-start",
            gap: 6,
          }}>
            <AlertTriangle size={11} color="#a16207" strokeWidth={2.2} style={{ marginTop: 1 }} />
            <Text style={[txt(500), { flex: 1, fontSize: 11, color: "#854d0e", lineHeight: 16 }]}>
              The address is from dispatch{hasPin ? "; the pin is the pickup driver's reported drop spot" : ""}. Confirm the trailer is where you expect before assuming it hasn't moved.
            </Text>
          </View>
        </View>
      ) : (
        <View style={{
          backgroundColor: "#faf5ff", borderRadius: 10, padding: 12, borderWidth: 1, borderColor: "#e9d5ff",
          flexDirection: "row", alignItems: "center", gap: 8,
        }}>
          <MapPin size={14} color="#9ca3af" strokeWidth={2.2} />
          <Text style={[txt(500), { flex: 1, fontSize: 12, color: "#6b7280", lineHeight: 16 }]}>
            Waiting on the trailer drop location — dispatch sets the address, the pickup driver pins the spot.
          </Text>
        </View>
      )}
    </View>
  );
}
