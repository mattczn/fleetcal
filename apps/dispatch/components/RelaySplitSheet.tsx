import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal, View, Text, TouchableOpacity, Pressable, ScrollView, ActivityIndicator,
  TextInput, Alert,
} from "react-native";
import {
  X, Truck, User, Clock, Repeat2, MapPin, Building2, Search, Bookmark,
  CheckCircle2, AlertCircle, ChevronLeft, ChevronRight,
} from "lucide-react-native";
import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";
import { AssetPickerSheet } from "@/components/AssetPickerSheet";
import { DriverPickerSheet } from "@/components/DriverPickerSheet";
import { DateTimePickerSheet } from "@/components/DateTimePickerSheet";
import {
  geocodeAddress, placesAutocomplete, placeDetails, fetchSavedLocations,
  type PlaceSuggestion, type SavedLocation,
} from "@/lib/api";
import { txt } from "@/lib/font";
import type { Asset, Driver, Stop } from "@/lib/types";

interface Props {
  visible:       boolean;
  orgId:         string;
  /** ISO end of the original load — used as default delivery-leg end. */
  loadEndIso:    string;
  stops:         Stop[];      // current stops list (used for position picker)
  assets:        Asset[];
  drivers:       Driver[];
  driverPrefs?:  Record<number, number>;
  pickupAssetId: number;
  saving:        boolean;
  onClose:       () => void;
  onConfirm: (opts: {
    deliveryAssetId:     number;
    deliveryDriverId:    number | null;
    deliveryDriverName:  string | null;
    pickupEndIso:        string;
    deliveryStartIso:    string;
    deliveryEndIso:      string;
    relayStop:           Stop;          // type='relay', with location + appt times
    insertAfterIdx:      number;        // 0-based index in current stops
  }) => void;
}

type Suggestion =
  | { kind: "saved"; loc: SavedLocation }
  | { kind: "place"; place: PlaceSuggestion };

function fmtFullDateTime(iso?: string): string {
  if (!iso) return "Not set";
  const d = new Date(iso.replace(" ", "T"));
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}
function pad(n: number): string { return String(n).padStart(2, "0"); }
function fmtIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function stopShort(s: Stop, idx: number): string {
  const label = s.facilityName ?? s.city ?? s.address ?? `Stop ${idx + 1}`;
  return label.length > 22 ? label.slice(0, 22) + "…" : label;
}

export function RelaySplitSheet({
  visible, orgId, loadEndIso, stops, assets, drivers, driverPrefs,
  pickupAssetId, saving, onClose, onConfirm,
}: Props) {
  const { getToken } = useAuth();
  const eligibleAssets = useMemo(
    () => assets.filter((a) => a.id !== pickupAssetId),
    [assets, pickupAssetId],
  );

  // Driver/asset
  const [delivAssetId,    setDelivAssetId]    = useState<number | null>(null);
  const [delivDriverId,   setDelivDriverId]   = useState<number | null>(null);
  const [delivDriverName, setDelivDriverName] = useState<string | null>(null);

  // Times
  const [pickupEnd,     setPickupEnd]     = useState<string>("");
  const [deliveryStart, setDeliveryStart] = useState<string>("");

  // Relay location
  const [facilityName, setFacilityName] = useState("");
  const [address,      setAddress]      = useState("");
  const [lat,          setLat]          = useState<number | undefined>(undefined);
  const [lng,          setLng]          = useState<number | undefined>(undefined);
  const [timezone,     setTimezone]     = useState<string | undefined>(undefined);
  const [verifyState,  setVerifyState]  = useState<"unverified" | "ok" | "failed">("unverified");
  const [verifiedAddress, setVerifiedAddress] = useState("");
  const [verifying,    setVerifying]    = useState(false);

  // Position
  // Default: insert AFTER the second-to-last stop ("before last stop").
  const defaultInsertIdx = Math.max(0, stops.length - 2);
  const [insertAfterIdx, setInsertAfterIdx] = useState(defaultInsertIdx);

  // Sub-sheets
  const [assetPickerVisible,  setAssetPickerVisible]  = useState(false);
  const [driverPickerVisible, setDriverPickerVisible] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);

  // Address autocomplete state
  const [placeResults, setPlaceResults] = useState<PlaceSuggestion[]>([]);
  const [showSuggestions, setShow]      = useState(false);
  const [autocompleteSeq, setAcSeq]     = useState(0);
  const justPickedRef                   = useRef(false);
  // One Places session token per address-editing session — threaded through
  // every autocomplete request and the final place-details call so Google
  // bills it as a single Autocomplete Session SKU. Reset after each pick.
  // (RN runtimes don't reliably expose crypto.randomUUID, so build a local id.)
  const placesTokenRef                  = useRef<string | null>(null);
  const getPlacesToken = () =>
    (placesTokenRef.current ??= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  // Facility-name autocomplete (saved locations only)
  const [showFacility, setShowFacility] = useState(false);
  const facilityJustPickedRef           = useRef(false);

  const { data: savedLocations = [] } = useQuery({
    queryKey: ["saved-locations", orgId],
    queryFn:  () => fetchSavedLocations(orgId),
    enabled:  !!orgId && visible,
    staleTime: 10 * 60 * 1000,
  });

  // Reset whenever the sheet opens.
  useEffect(() => {
    if (!visible) return;
    setDelivAssetId(null);
    setDelivDriverId(null);
    setDelivDriverName(null);
    setFacilityName("");
    setAddress("");
    setLat(undefined); setLng(undefined); setTimezone(undefined);
    setVerifyState("unverified"); setVerifiedAddress("");
    setInsertAfterIdx(Math.max(0, stops.length - 2));
    setShow(false); setPlaceResults([]);

    // Default split times: drop = end - 1h, pickup = end - 30m
    const end = new Date(loadEndIso.replace(" ", "T"));
    if (!isNaN(end.getTime())) {
      const drop = new Date(end.getTime() - 60 * 60 * 1000);
      const pick = new Date(end.getTime() - 30 * 60 * 1000);
      setPickupEnd(fmtIso(drop));
      setDeliveryStart(fmtIso(pick));
    } else {
      setPickupEnd(""); setDeliveryStart("");
    }
  }, [visible, loadEndIso, stops.length]);

  // Stale verify check
  useEffect(() => {
    if (!visible) return;
    if (verifyState === "ok" && address.trim() !== verifiedAddress.trim()) {
      setVerifyState("unverified");
    }
  }, [address, visible, verifyState, verifiedAddress]);

  // Saved locations matched against facility-name input
  const matchedFacilities: SavedLocation[] = (() => {
    const q = facilityName.trim().toLowerCase();
    if (q.length < 1) return [];
    return savedLocations.filter((l) => l.name.toLowerCase().includes(q)).slice(0, 6);
  })();
  useEffect(() => {
    if (!visible) return;
    if (facilityJustPickedRef.current) { facilityJustPickedRef.current = false; setShowFacility(false); return; }
    setShowFacility(matchedFacilities.length > 0 && facilityName.trim().length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facilityName, visible, savedLocations]);
  function pickFacility(loc: SavedLocation) {
    facilityJustPickedRef.current = true;
    justPickedRef.current = true;
    setShowFacility(false);
    setFacilityName(loc.name);
    if (loc.address) setAddress(loc.address);
    if (loc.lat != null) setLat(loc.lat);
    if (loc.lng != null) setLng(loc.lng);
    if (loc.timezone) setTimezone(loc.timezone);
    if (loc.lat != null && loc.lng != null) {
      setVerifiedAddress(loc.address ?? "");
      setVerifyState("ok");
    }
  }

  // Saved locations matched by typed query
  const matchedSaved: SavedLocation[] = (() => {
    const q = address.trim().toLowerCase();
    if (q.length < 1) return [];
    return savedLocations.filter((l) =>
      l.name.toLowerCase().includes(q) || (l.address ?? "").toLowerCase().includes(q),
    ).slice(0, 5);
  })();

  // Debounced Google autocomplete
  useEffect(() => {
    if (!visible) return;
    if (justPickedRef.current) { justPickedRef.current = false; return; }
    const q = address.trim();
    if (q.length < 3) { setPlaceResults([]); setShow(matchedSaved.length > 0); return; }
    const seq = autocompleteSeq + 1;
    setAcSeq(seq);
    const t = setTimeout(async () => {
      const results = await placesAutocomplete(getToken, q, getPlacesToken());
      setAcSeq((cur) => {
        if (cur !== seq) return cur;
        setPlaceResults(results);
        return cur;
      });
      setShow(true);
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, visible]);

  const suggestions: Suggestion[] = [
    ...matchedSaved.map((loc) => ({ kind: "saved" as const, loc })),
    ...placeResults.map((place) => ({ kind: "place" as const, place })),
  ];

  async function pickPlace(p: PlaceSuggestion) {
    justPickedRef.current = true;
    setShow(false);
    setPlaceResults([]);
    const details = await placeDetails(getToken, p.placeId, getPlacesToken());
    // Session complete — next address edit starts a fresh token.
    placesTokenRef.current = null;
    if (!details) { setAddress(p.description); return; }
    setAddress(details.address);
    setLat(details.lat);
    setLng(details.lng);
    if (details.timezone) setTimezone(details.timezone);
    setVerifiedAddress(details.address);
    setVerifyState("ok");
  }
  function pickSaved(loc: SavedLocation) {
    justPickedRef.current = true;
    setShow(false);
    setPlaceResults([]);
    if (!facilityName.trim()) setFacilityName(loc.name);
    if (loc.address) setAddress(loc.address);
    if (loc.lat != null) setLat(loc.lat);
    if (loc.lng != null) setLng(loc.lng);
    if (loc.timezone) setTimezone(loc.timezone);
    if (loc.lat != null && loc.lng != null) {
      setVerifiedAddress(loc.address ?? "");
      setVerifyState("ok");
    }
  }
  async function verifyManually() {
    if (!address.trim() || verifying) return;
    setVerifying(true);
    try {
      const result = await geocodeAddress(getToken, address.trim());
      if (result) {
        setLat(result.lat); setLng(result.lng);
        if (result.timezone) setTimezone(result.timezone);
        setVerifiedAddress(address.trim());
        setVerifyState("ok");
      } else {
        setVerifyState("failed");
      }
    } finally { setVerifying(false); }
  }

  function pickAsset(a: Asset) {
    setAssetPickerVisible(false);
    setDelivAssetId(a.id);
    const prefId = driverPrefs?.[a.id];
    if (prefId != null) {
      const d = drivers.find((x) => x.id === prefId);
      if (d) {
        setDelivDriverId(d.id);
        setDelivDriverName(d.name);
        return;
      }
    }
    setDelivDriverId(null);
    setDelivDriverName(null);
  }

  const ready = delivAssetId != null && pickupEnd && deliveryStart;
  const delivAsset  = assets.find((a) => a.id === delivAssetId);
  const beforeStop  = stops[insertAfterIdx];
  const afterStop   = stops[insertAfterIdx + 1];
  const canMoveLeft  = insertAfterIdx > 0;
  const canMoveRight = insertAfterIdx < stops.length - 2;

  function handleReviewAndConfirm() {
    if (!ready || delivAssetId == null) return;
    const summary =
      `Delivery driver: ${delivDriverName ?? "(none)"} — ${delivAsset?.name ?? ""}\n` +
      `Driver 1 drops: ${fmtFullDateTime(pickupEnd)}\n` +
      `Driver 2 picks up: ${fmtFullDateTime(deliveryStart)}\n` +
      `Relay location: ${facilityName.trim() || address.trim() || "(not set)"}\n` +
      `Position: between "${beforeStop ? stopShort(beforeStop, insertAfterIdx) : "—"}" ` +
      `and "${afterStop ? stopShort(afterStop, insertAfterIdx + 1) : "—"}"`;
    Alert.alert(
      "Confirm relay split",
      summary,
      [
        { text: "Back", style: "cancel" },
        { text: "Split load", onPress: () => {
          const relayStop: Stop = {
            id:        `tmp-relay-${Date.now()}`,
            sequence:  0,
            type:      "relay",
            facilityName: facilityName.trim() || undefined,
            address:      address.trim()      || undefined,
            lat, lng, timezone,
            apptStart: pickupEnd,
            apptEnd:   deliveryStart,
          };
          onConfirm({
            deliveryAssetId:    delivAssetId,
            deliveryDriverId:   delivDriverId,
            deliveryDriverName: delivDriverName,
            pickupEndIso:       pickupEnd,
            deliveryStartIso:   deliveryStart,
            deliveryEndIso:     loadEndIso,
            relayStop,
            insertAfterIdx,
          });
        }},
      ],
    );
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: "#ffffff",
            borderTopLeftRadius: 20, borderTopRightRadius: 20,
            maxHeight: "94%",
            paddingBottom: 28, paddingTop: 8,
          }}
        >
          <View style={{
            flexDirection: "row", alignItems: "center", gap: 8,
            paddingHorizontal: 18, paddingVertical: 14,
            borderBottomWidth: 1, borderBottomColor: "#f1f3f4",
          }}>
            <Repeat2 size={18} color="#6b21a8" strokeWidth={2.4} />
            <Text style={[txt(800), { fontSize: 16, color: "#202124", flex: 1 }]}>
              Split into Relay
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={20} color="#5f6368" strokeWidth={2.2} />
            </TouchableOpacity>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: 8 }}>
            {/* Delivery driver */}
            <Text style={[txt(800), { fontSize: 11, color: "#5f6368", letterSpacing: 0.6, marginBottom: 8 }]}>
              DELIVERY DRIVER
            </Text>
            <TouchableOpacity
              onPress={() => setAssetPickerVisible(true)}
              activeOpacity={0.7}
              style={{
                flexDirection: "row", alignItems: "center", gap: 10,
                paddingHorizontal: 12, paddingVertical: 12,
                backgroundColor: "#f1f3f4", borderRadius: 12, marginBottom: 8,
              }}
            >
              <Truck size={15} color="#5f6368" strokeWidth={2.2} />
              <Text style={[txt(600), { fontSize: 12, color: "#5f6368", width: 50 }]}>Asset</Text>
              <Text style={[txt(700), { fontSize: 14, color: delivAsset ? "#202124" : "#9aa0a6", flex: 1 }]} numberOfLines={1}>
                {delivAsset?.name ?? "Tap to select"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setDriverPickerVisible(true)}
              activeOpacity={0.7}
              disabled={delivAssetId == null}
              style={{
                flexDirection: "row", alignItems: "center", gap: 10,
                paddingHorizontal: 12, paddingVertical: 12,
                backgroundColor: "#f1f3f4", borderRadius: 12, marginBottom: 16,
                opacity: delivAssetId == null ? 0.5 : 1,
              }}
            >
              <User size={15} color="#5f6368" strokeWidth={2.2} />
              <Text style={[txt(600), { fontSize: 12, color: "#5f6368", width: 50 }]}>Driver</Text>
              <Text style={[txt(700), { fontSize: 14, color: delivDriverName ? "#202124" : "#9aa0a6", flex: 1 }]} numberOfLines={1}>
                {delivDriverName ?? (delivAssetId == null ? "Pick asset first" : "Optional · tap to pick")}
              </Text>
            </TouchableOpacity>

            {/* Handoff times */}
            <Text style={[txt(800), { fontSize: 11, color: "#5f6368", letterSpacing: 0.6, marginBottom: 8 }]}>
              HANDOFF TIMES
            </Text>
            <TouchableOpacity
              onPress={() => setHandoffOpen(true)}
              activeOpacity={0.7}
              style={{
                flexDirection: "row", alignItems: "center", gap: 10,
                paddingHorizontal: 12, paddingVertical: 12,
                backgroundColor: "#f1f3f4", borderRadius: 12, marginBottom: 16,
              }}
            >
              <Clock size={15} color="#5f6368" strokeWidth={2.2} />
              <View style={{ flex: 1 }}>
                <Text style={[txt(600), { fontSize: 11, color: "#5f6368", letterSpacing: 0.4 }]}>DRIVER 1 DROP</Text>
                <Text style={[txt(700), { fontSize: 14, color: pickupEnd ? "#202124" : "#9aa0a6" }]} numberOfLines={1}>
                  {fmtFullDateTime(pickupEnd)}
                </Text>
                <Text style={[txt(600), { fontSize: 11, color: "#5f6368", letterSpacing: 0.4, marginTop: 4 }]}>DRIVER 2 PICKUP</Text>
                <Text style={[txt(700), { fontSize: 14, color: deliveryStart ? "#202124" : "#9aa0a6" }]} numberOfLines={1}>
                  {fmtFullDateTime(deliveryStart)}
                </Text>
              </View>
            </TouchableOpacity>

            {/* Relay location */}
            <Text style={[txt(800), { fontSize: 11, color: "#5f6368", letterSpacing: 0.6, marginBottom: 8 }]}>
              RELAY LOCATION
            </Text>
            <View style={{
              flexDirection: "row", alignItems: "center", gap: 8,
              paddingHorizontal: 12, paddingVertical: 10,
              backgroundColor: "#f1f3f4", borderRadius: 12,
              marginBottom: showFacility ? 4 : 8,
            }}>
              <Building2 size={15} color="#5f6368" strokeWidth={2.2} />
              <TextInput
                value={facilityName}
                onChangeText={setFacilityName}
                placeholder="Facility / yard name"
                placeholderTextColor="#9aa0a6"
                autoCapitalize="words"
                style={[txt(600), { flex: 1, fontSize: 14, color: "#202124", padding: 0 }]}
              />
            </View>

            {showFacility && matchedFacilities.length > 0 ? (
              <View style={{
                marginBottom: 8,
                backgroundColor: "#ffffff",
                borderRadius: 12,
                borderWidth: 1, borderColor: "#e8eaed",
                overflow: "hidden",
              }}>
                {matchedFacilities.map((loc, i) => (
                  <TouchableOpacity
                    key={`fac-${loc.id}`}
                    onPress={() => pickFacility(loc)}
                    activeOpacity={0.6}
                    style={{
                      flexDirection: "row", alignItems: "center", gap: 10,
                      paddingHorizontal: 12, paddingVertical: 10,
                      backgroundColor: "#f8fbff",
                      borderBottomWidth: i === matchedFacilities.length - 1 ? 0 : 1,
                      borderBottomColor: "#f1f3f4",
                    }}
                  >
                    <Bookmark size={13} color="#1a73e8" strokeWidth={2.4} fill="#1a73e8" />
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <Text style={[txt(800), { fontSize: 13, color: "#202124" }]} numberOfLines={1}>
                          {loc.name}
                        </Text>
                        <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: "#e8f0fe" }}>
                          <Text style={[txt(800), { fontSize: 9, color: "#1a73e8", letterSpacing: 0.4 }]}>SAVED</Text>
                        </View>
                      </View>
                      {loc.address ? (
                        <Text style={[txt(500), { fontSize: 11, color: "#5f6368", marginTop: 1 }]} numberOfLines={1}>
                          {loc.address}
                        </Text>
                      ) : null}
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}
            <View style={{
              flexDirection: "row", alignItems: "flex-start", gap: 8,
              paddingHorizontal: 12, paddingVertical: 10,
              backgroundColor: "#f1f3f4", borderRadius: 12, marginBottom: 8,
            }}>
              <MapPin size={15} color="#5f6368" strokeWidth={2.2} style={{ marginTop: 2 }} />
              <TextInput
                value={address}
                onChangeText={setAddress}
                placeholder="Street, city, state, ZIP"
                placeholderTextColor="#9aa0a6"
                autoCapitalize="words"
                multiline
                style={[txt(600), { flex: 1, fontSize: 14, color: "#202124", padding: 0, minHeight: 22 }]}
              />
            </View>

            {showSuggestions && suggestions.length > 0 ? (
              <View style={{
                marginBottom: 8,
                backgroundColor: "#ffffff",
                borderRadius: 12,
                borderWidth: 1, borderColor: "#e8eaed",
                overflow: "hidden",
              }}>
                {suggestions.map((s, i) => {
                  const isLast = i === suggestions.length - 1;
                  if (s.kind === "saved") {
                    return (
                      <TouchableOpacity key={`s-${s.loc.id}`} onPress={() => pickSaved(s.loc)} activeOpacity={0.6}
                        style={{
                          flexDirection: "row", alignItems: "center", gap: 10,
                          paddingHorizontal: 12, paddingVertical: 10,
                          backgroundColor: "#f8fbff",
                          borderBottomWidth: isLast ? 0 : 1, borderBottomColor: "#f1f3f4",
                        }}>
                        <Bookmark size={13} color="#1a73e8" strokeWidth={2.4} fill="#1a73e8" />
                        <View style={{ flex: 1 }}>
                          <Text style={[txt(800), { fontSize: 13, color: "#202124" }]} numberOfLines={1}>
                            {s.loc.name}
                          </Text>
                          {s.loc.address ? (
                            <Text style={[txt(500), { fontSize: 11, color: "#5f6368", marginTop: 1 }]} numberOfLines={1}>
                              {s.loc.address}
                            </Text>
                          ) : null}
                        </View>
                      </TouchableOpacity>
                    );
                  }
                  return (
                    <TouchableOpacity key={`p-${s.place.placeId}`} onPress={() => pickPlace(s.place)} activeOpacity={0.6}
                      style={{
                        flexDirection: "row", alignItems: "center", gap: 10,
                        paddingHorizontal: 12, paddingVertical: 10,
                        borderBottomWidth: isLast ? 0 : 1, borderBottomColor: "#f1f3f4",
                      }}>
                      <Search size={13} color="#5f6368" strokeWidth={2.2} />
                      <Text style={[txt(600), { fontSize: 13, color: "#202124", flex: 1 }]} numberOfLines={2}>
                        {s.place.description}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : null}

            <View style={{
              flexDirection: "row", alignItems: "center", justifyContent: "space-between",
              marginBottom: 16,
            }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
                {verifyState === "ok" ? (
                  <>
                    <CheckCircle2 size={13} color="#15803d" strokeWidth={2.4} />
                    <Text style={[txt(700), { fontSize: 11, color: "#15803d" }]} numberOfLines={1}>
                      Verified · {lat?.toFixed(4)}, {lng?.toFixed(4)}
                    </Text>
                  </>
                ) : verifyState === "failed" ? (
                  <>
                    <AlertCircle size={13} color="#b91c1c" strokeWidth={2.4} />
                    <Text style={[txt(700), { fontSize: 11, color: "#b91c1c" }]}>Couldn&apos;t find that address</Text>
                  </>
                ) : (
                  <Text style={[txt(500), { fontSize: 11, color: "#9aa0a6" }]}>
                    Coordinates not verified
                  </Text>
                )}
              </View>
              <TouchableOpacity
                onPress={verifyManually}
                disabled={!address.trim() || verifying}
                activeOpacity={0.7}
                style={{
                  paddingHorizontal: 12, paddingVertical: 6,
                  backgroundColor: address.trim() && !verifying ? "#e8f0fe" : "#f1f3f4",
                  borderRadius: 999,
                  borderWidth: 1, borderColor: address.trim() && !verifying ? "#bfdbfe" : "transparent",
                }}
              >
                {verifying ? <ActivityIndicator size="small" color="#1a73e8" /> : (
                  <Text style={[txt(800), { fontSize: 11, color: address.trim() ? "#1a73e8" : "#9aa0a6", letterSpacing: 0.3 }]}>
                    Verify
                  </Text>
                )}
              </TouchableOpacity>
            </View>

            {/* Position picker */}
            <Text style={[txt(800), { fontSize: 11, color: "#5f6368", letterSpacing: 0.6, marginBottom: 8 }]}>
              POSITION IN ROUTE
            </Text>
            <View style={{
              flexDirection: "row", alignItems: "center", gap: 6,
              paddingHorizontal: 8, paddingVertical: 10,
              backgroundColor: "#f1f3f4", borderRadius: 12, marginBottom: 6,
            }}>
              <TouchableOpacity
                onPress={() => canMoveLeft && setInsertAfterIdx((i) => i - 1)}
                disabled={!canMoveLeft}
                hitSlop={8}
                style={{
                  width: 30, height: 30, borderRadius: 10,
                  backgroundColor: canMoveLeft ? "#ffffff" : "transparent",
                  alignItems: "center", justifyContent: "center",
                  opacity: canMoveLeft ? 1 : 0.3,
                }}
              >
                <ChevronLeft size={16} color="#1a73e8" strokeWidth={2.4} />
              </TouchableOpacity>
              <View style={{ flex: 1, alignItems: "center" }}>
                <Text style={[txt(700), { fontSize: 11, color: "#5f6368" }]}>Insert relay between</Text>
                <Text style={[txt(800), { fontSize: 13, color: "#202124", marginTop: 2, textAlign: "center" }]} numberOfLines={2}>
                  {beforeStop ? stopShort(beforeStop, insertAfterIdx) : "—"} <Text style={[txt(500), { color: "#9aa0a6" }]}>and</Text> {afterStop ? stopShort(afterStop, insertAfterIdx + 1) : "—"}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => canMoveRight && setInsertAfterIdx((i) => i + 1)}
                disabled={!canMoveRight}
                hitSlop={8}
                style={{
                  width: 30, height: 30, borderRadius: 10,
                  backgroundColor: canMoveRight ? "#ffffff" : "transparent",
                  alignItems: "center", justifyContent: "center",
                  opacity: canMoveRight ? 1 : 0.3,
                }}
              >
                <ChevronRight size={16} color="#1a73e8" strokeWidth={2.4} />
              </TouchableOpacity>
            </View>
            <Text style={[txt(500), { fontSize: 11, color: "#9aa0a6", paddingHorizontal: 4, marginBottom: 8 }]}>
              Default: just before the last stop.
            </Text>
          </ScrollView>

          <View style={{
            flexDirection: "row", gap: 10,
            paddingHorizontal: 18, paddingTop: 8,
            borderTopWidth: 1, borderTopColor: "#f1f3f4",
          }}>
            <TouchableOpacity
              onPress={onClose}
              activeOpacity={0.7}
              disabled={saving}
              style={{
                flex: 1, paddingVertical: 14, borderRadius: 14,
                backgroundColor: "#f1f3f4",
                alignItems: "center",
                opacity: saving ? 0.5 : 1,
              }}
            >
              <Text style={[txt(800), { fontSize: 14, color: "#3c4043" }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleReviewAndConfirm}
              activeOpacity={ready && !saving ? 0.85 : 1}
              disabled={!ready || saving}
              style={{
                flex: 2, paddingVertical: 14, borderRadius: 14,
                backgroundColor: ready && !saving ? "#7c3aed" : "#ddd6fe",
                alignItems: "center",
                flexDirection: "row", justifyContent: "center", gap: 8,
              }}
            >
              {saving ? <ActivityIndicator size="small" color="#ffffff" /> : (
                <Repeat2 size={15} color="#ffffff" strokeWidth={2.6} />
              )}
              <Text style={[txt(800), { fontSize: 14, color: "#ffffff", letterSpacing: 0.3 }]}>
                Review & confirm
              </Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>

      <AssetPickerSheet
        visible={assetPickerVisible}
        title="Delivery asset"
        assets={eligibleAssets}
        onClose={() => setAssetPickerVisible(false)}
        onSelect={pickAsset}
      />
      <DriverPickerSheet
        visible={driverPickerVisible}
        orgId={orgId}
        currentId={delivDriverId ?? undefined}
        onClose={() => setDriverPickerVisible(false)}
        onSelect={(driverId, driverName) => {
          setDriverPickerVisible(false);
          setDelivDriverId(driverId);
          setDelivDriverName(driverName);
        }}
      />
      <DateTimePickerSheet
        visible={handoffOpen}
        mode="range"
        title="Handoff times"
        initialStart={pickupEnd}
        initialEnd={deliveryStart}
        onClose={() => setHandoffOpen(false)}
        onSave={(range) => {
          setPickupEnd(range.start);
          setDeliveryStart(range.end);
          setHandoffOpen(false);
        }}
      />
    </Modal>
  );
}
