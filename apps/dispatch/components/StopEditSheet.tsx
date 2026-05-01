import React, { useEffect, useRef, useState } from "react";
import {
  Modal, View, Text, TouchableOpacity, Pressable, TextInput, ScrollView,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from "react-native";
import { X, MapPin, Clock, CheckCircle2, AlertCircle, Building2, Search, Bookmark } from "lucide-react-native";
import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";
import {
  geocodeAddress, placesAutocomplete, placeDetails, fetchSavedLocations, fetchRecentStops,
  type PlaceSuggestion, type SavedLocation,
} from "@/lib/api";
import { DateTimePickerSheet } from "@/components/DateTimePickerSheet";
import { txt } from "@/lib/font";
import type { Stop, StopType } from "@/lib/types";

const STOP_TYPES: { value: StopType; label: string; bg: string; fg: string }[] = [
  { value: "pickup",    label: "Pickup",    bg: "#dcfce7", fg: "#15803d" },
  { value: "delivery",  label: "Delivery",  bg: "#fee2e2", fg: "#b91c1c" },
  { value: "drop_hook", label: "Drop & Hook", bg: "#dbeafe", fg: "#1e40af" },
  { value: "stop",      label: "Stop",      bg: "#fef9c3", fg: "#854d0e" },
];

interface Props {
  visible: boolean;
  orgId:   string;
  stop:    Stop | null;
  onClose: () => void;
  onSave:  (next: Stop) => void;
}

type Suggestion =
  | { kind: "saved";  loc:  SavedLocation }
  | { kind: "place";  place: PlaceSuggestion };

function fmtFullDateTime(iso?: string): string {
  if (!iso) return "Not set";
  const d = new Date(iso.replace(" ", "T"));
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

export function StopEditSheet({ visible, orgId, stop, onClose, onSave }: Props) {
  const { getToken } = useAuth();

  const { data: savedLocations = [] } = useQuery({
    queryKey: ["saved-locations", orgId],
    queryFn:  () => fetchSavedLocations(orgId),
    enabled:  !!orgId,
    staleTime: 10 * 60 * 1000,
  });

  // Recent stops query — keyed by facility-name input, debounced via the same
  // delay as Google Places to avoid hammering the DB per keystroke.
  const [recentQuery, setRecentQuery] = useState("");
  const { data: recentStops = [] } = useQuery({
    queryKey: ["recent-stops", orgId, recentQuery],
    queryFn:  () => fetchRecentStops(orgId, recentQuery),
    enabled:  !!orgId && recentQuery.trim().length >= 2,
    staleTime: 60 * 1000,
  });

  const [type,         setType]         = useState<StopType>("pickup");
  const [facilityName, setFacilityName] = useState("");
  const [address,      setAddress]      = useState("");
  const [apptStart,    setApptStart]    = useState<string | undefined>(undefined);
  const [apptEnd,      setApptEnd]      = useState<string | undefined>(undefined);
  const [instructions, setInstructions] = useState("");
  const [lat,          setLat]          = useState<number | undefined>(undefined);
  const [lng,          setLng]          = useState<number | undefined>(undefined);
  const [timezone,     setTimezone]     = useState<string | undefined>(undefined);

  const [verifying,  setVerifying]  = useState(false);
  const [verifyState, setVerifyState] = useState<"unverified" | "ok" | "failed">("unverified");
  // Address text that corresponds to the current lat/lng. The "marked stale"
  // check compares the typed address against this — not the original stop —
  // so picking a suggestion (which writes a NEW address + coords together)
  // doesn't immediately get flagged as stale.
  const [verifiedAddress, setVerifiedAddress] = useState("");
  const [windowOpen, setWindowOpen] = useState(false);

  // Suggestions list — merges saved locations (matched against the typed query)
  // with Google Places autocomplete results. Saved locations always come first.
  const [placeResults, setPlaceResults] = useState<PlaceSuggestion[]>([]);
  const [showSuggestions, setShow]      = useState(false);
  const [autocompleteSeq, setAcSeq]     = useState(0); // race-guard
  const justPickedRef                   = useRef(false);

  // Facility-name autocomplete: saved locations + recent load stops.
  type FacilitySuggestion = {
    kind:     "saved" | "recent";
    name:     string;
    address?: string;
    lat?:     number;
    lng?:     number;
    timezone?: string;
  };
  const [showFacility, setShowFacility] = useState(false);
  const facilityJustPickedRef           = useRef(false);

  // Debounce facility-name → recent-stops query (300ms)
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => setRecentQuery(facilityName.trim()), 300);
    return () => clearTimeout(t);
  }, [facilityName, visible]);

  const matchedFacilities: FacilitySuggestion[] = (() => {
    const q = facilityName.trim().toLowerCase();
    if (q.length < 1) return [];
    const out: FacilitySuggestion[] = [];
    const seen = new Set<string>();
    for (const l of savedLocations) {
      if (!l.name.toLowerCase().includes(q)) continue;
      const key = l.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "saved", name: l.name, address: l.address, lat: l.lat, lng: l.lng, timezone: l.timezone });
      if (out.length >= 6) return out;
    }
    for (const r of recentStops) {
      if (!r.facilityName) continue;
      if (!r.facilityName.toLowerCase().includes(q)) continue;
      const key = r.facilityName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "recent", name: r.facilityName, address: r.address, lat: r.lat, lng: r.lng, timezone: r.timezone });
      if (out.length >= 6) return out;
    }
    return out;
  })();
  useEffect(() => {
    if (!visible) return;
    if (facilityJustPickedRef.current) { facilityJustPickedRef.current = false; setShowFacility(false); return; }
    setShowFacility(matchedFacilities.length > 0 && facilityName.trim().length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facilityName, visible, savedLocations, recentStops]);
  function pickFacility(s: FacilitySuggestion) {
    facilityJustPickedRef.current = true;
    justPickedRef.current = true;
    setShowFacility(false);
    setFacilityName(s.name);
    if (s.address) setAddress(s.address);
    if (s.lat != null) setLat(s.lat);
    if (s.lng != null) setLng(s.lng);
    if (s.timezone) setTimezone(s.timezone);
    if (s.lat != null && s.lng != null) {
      setVerifiedAddress(s.address ?? "");
      setVerifyState("ok");
    }
  }

  useEffect(() => {
    if (!visible || !stop) return;
    setType(stop.type === "relay" ? "stop" : stop.type);
    setFacilityName(stop.facilityName ?? "");
    setAddress(stop.address ?? "");
    setApptStart(stop.apptStart);
    setApptEnd(stop.apptEnd);
    setInstructions(stop.instructions ?? "");
    setLat(stop.lat);
    setLng(stop.lng);
    setTimezone(stop.timezone);
    // Pre-existing coords are considered verified; user can re-verify after edits.
    setVerifyState(stop.lat != null && stop.lng != null ? "ok" : "unverified");
    setVerifiedAddress(stop.address ?? "");
  }, [visible, stop]);

  // Mark coords stale only when the typed address diverges from the address
  // that produced the current verified coords.
  useEffect(() => {
    if (!visible) return;
    if (verifyState === "ok" && address.trim() !== verifiedAddress.trim()) {
      setVerifyState("unverified");
    }
  }, [address, visible, verifyState, verifiedAddress]);

  // Saved locations whose name OR address contains the typed query.
  const matchedSaved: SavedLocation[] = (() => {
    const q = address.trim().toLowerCase();
    if (q.length < 1) return [];
    return savedLocations.filter((l) =>
      l.name.toLowerCase().includes(q) || (l.address ?? "").toLowerCase().includes(q),
    ).slice(0, 5);
  })();

  // Debounced Places autocomplete on address input. Skips a tick right after
  // the user picks a suggestion to avoid re-popping the list.
  useEffect(() => {
    if (!visible) return;
    if (justPickedRef.current) { justPickedRef.current = false; return; }
    const q = address.trim();
    if (q.length < 3) { setPlaceResults([]); setShow(matchedSaved.length > 0); return; }
    const seq = autocompleteSeq + 1;
    setAcSeq(seq);
    const t = setTimeout(async () => {
      const results = await placesAutocomplete(getToken, q);
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

  // Combined suggestion list: saved locations first, then Google Places.
  const suggestions: Suggestion[] = [
    ...matchedSaved.map((loc) => ({ kind: "saved" as const, loc })),
    ...placeResults.map((place) => ({ kind: "place" as const, place })),
  ];

  async function pickPlace(p: PlaceSuggestion) {
    justPickedRef.current = true;
    setShow(false);
    setPlaceResults([]);
    const details = await placeDetails(getToken, p.placeId);
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

  async function verifyAddress() {
    if (!address.trim() || verifying) return;
    setVerifying(true);
    try {
      const result = await geocodeAddress(getToken, address.trim());
      if (result) {
        setLat(result.lat);
        setLng(result.lng);
        if (result.timezone) setTimezone(result.timezone);
        setVerifiedAddress(address.trim());
        setVerifyState("ok");
      } else {
        setVerifyState("failed");
      }
    } finally {
      setVerifying(false);
    }
  }

  function handleSave() {
    if (!stop) return;
    onSave({
      ...stop,
      type,
      facilityName: facilityName.trim() || undefined,
      address:      address.trim()      || undefined,
      apptStart,
      apptEnd,
      instructions: instructions.trim() || undefined,
      lat,
      lng,
      timezone,
    });
  }

  const dirty = stop && (
    type !== (stop.type === "relay" ? "stop" : stop.type) ||
    facilityName.trim() !== (stop.facilityName ?? "") ||
    address.trim() !== (stop.address ?? "") ||
    apptStart !== stop.apptStart ||
    apptEnd !== stop.apptEnd ||
    instructions.trim() !== (stop.instructions ?? "") ||
    lat !== stop.lat ||
    lng !== stop.lng
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)" }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={{ flex: 1, justifyContent: "flex-end" }}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              backgroundColor: "#ffffff",
              borderTopLeftRadius: 20, borderTopRightRadius: 20,
              maxHeight: "92%",
              paddingBottom: 28, paddingTop: 8,
            }}
          >
            <View style={{
              flexDirection: "row", alignItems: "center",
              paddingHorizontal: 18, paddingVertical: 14,
              borderBottomWidth: 1, borderBottomColor: "#f1f3f4",
            }}>
              <Text style={[txt(800), { fontSize: 16, color: "#202124", flex: 1 }]}>
                Edit Stop
              </Text>
              <TouchableOpacity onPress={onClose} hitSlop={10}>
                <X size={20} color="#5f6368" strokeWidth={2.2} />
              </TouchableOpacity>
            </View>

            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: 8 }}
            >
              {/* Type pills */}
              <Text style={[txt(800), { fontSize: 11, color: "#5f6368", letterSpacing: 0.6, marginBottom: 8 }]}>
                TYPE
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
                {STOP_TYPES.map((t) => {
                  const active = type === t.value;
                  return (
                    <TouchableOpacity
                      key={t.value}
                      onPress={() => setType(t.value)}
                      activeOpacity={0.7}
                      style={{
                        paddingHorizontal: 12, paddingVertical: 8,
                        borderRadius: 999,
                        backgroundColor: active ? t.bg : "#f1f3f4",
                        borderWidth: 1, borderColor: active ? t.fg : "transparent",
                      }}
                    >
                      <Text style={[txt(800), { fontSize: 12, color: active ? t.fg : "#5f6368", letterSpacing: 0.3 }]}>
                        {t.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Facility name */}
              <Text style={[txt(800), { fontSize: 11, color: "#5f6368", letterSpacing: 0.6, marginBottom: 6 }]}>
                FACILITY
              </Text>
              <View style={{
                flexDirection: "row", alignItems: "center", gap: 8,
                paddingHorizontal: 12, paddingVertical: 10,
                backgroundColor: "#f1f3f4", borderRadius: 12,
                marginBottom: showFacility ? 4 : 14,
              }}>
                <Building2 size={15} color="#5f6368" strokeWidth={2.2} />
                <TextInput
                  value={facilityName}
                  onChangeText={setFacilityName}
                  placeholder="Facility / shipper name"
                  placeholderTextColor="#9aa0a6"
                  autoCapitalize="words"
                  style={[txt(600), { flex: 1, fontSize: 14, color: "#202124", padding: 0 }]}
                />
              </View>

              {showFacility && matchedFacilities.length > 0 ? (
                <View style={{
                  marginBottom: 10,
                  backgroundColor: "#ffffff",
                  borderRadius: 12,
                  borderWidth: 1, borderColor: "#e8eaed",
                  overflow: "hidden",
                }}>
                  {matchedFacilities.map((s, i) => {
                    const saved = s.kind === "saved";
                    return (
                      <TouchableOpacity
                        key={`fac-${i}-${s.name}`}
                        onPress={() => pickFacility(s)}
                        activeOpacity={0.6}
                        style={{
                          flexDirection: "row", alignItems: "center", gap: 10,
                          paddingHorizontal: 12, paddingVertical: 10,
                          backgroundColor: saved ? "#f8fbff" : "#fafafa",
                          borderBottomWidth: i === matchedFacilities.length - 1 ? 0 : 1,
                          borderBottomColor: "#f1f3f4",
                        }}
                      >
                        <Bookmark
                          size={13}
                          color={saved ? "#1a73e8" : "#9aa0a6"}
                          strokeWidth={2.4}
                          fill={saved ? "#1a73e8" : "transparent"}
                        />
                        <View style={{ flex: 1 }}>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                            <Text style={[txt(800), { fontSize: 13, color: "#202124" }]} numberOfLines={1}>
                              {s.name}
                            </Text>
                            <View style={{
                              paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999,
                              backgroundColor: saved ? "#e8f0fe" : "#f1f3f4",
                            }}>
                              <Text style={[txt(800), {
                                fontSize: 9,
                                color: saved ? "#1a73e8" : "#5f6368",
                                letterSpacing: 0.4,
                              }]}>
                                {saved ? "SAVED" : "RECENT"}
                              </Text>
                            </View>
                          </View>
                          {s.address ? (
                            <Text style={[txt(500), { fontSize: 11, color: "#5f6368", marginTop: 1 }]} numberOfLines={1}>
                              {s.address}
                            </Text>
                          ) : null}
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ) : null}

              {/* Address + verify */}
              <Text style={[txt(800), { fontSize: 11, color: "#5f6368", letterSpacing: 0.6, marginBottom: 6 }]}>
                ADDRESS
              </Text>
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

              {/* Autocomplete + saved-location suggestions */}
              {showSuggestions && suggestions.length > 0 ? (
                <View style={{
                  marginTop: -2, marginBottom: 8,
                  backgroundColor: "#ffffff",
                  borderRadius: 12,
                  borderWidth: 1, borderColor: "#e8eaed",
                  overflow: "hidden",
                }}>
                  {suggestions.map((s, i) => {
                    const isLast = i === suggestions.length - 1;
                    if (s.kind === "saved") {
                      return (
                        <TouchableOpacity
                          key={`saved-${s.loc.id}`}
                          onPress={() => pickSaved(s.loc)}
                          activeOpacity={0.6}
                          style={{
                            flexDirection: "row", alignItems: "center", gap: 10,
                            paddingHorizontal: 12, paddingVertical: 10,
                            backgroundColor: "#f8fbff",
                            borderBottomWidth: isLast ? 0 : 1, borderBottomColor: "#f1f3f4",
                          }}
                        >
                          <Bookmark size={13} color="#1a73e8" strokeWidth={2.4} fill="#1a73e8" />
                          <View style={{ flex: 1 }}>
                            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                              <Text style={[txt(800), { fontSize: 13, color: "#202124" }]} numberOfLines={1}>
                                {s.loc.name}
                              </Text>
                              <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: "#e8f0fe" }}>
                                <Text style={[txt(800), { fontSize: 9, color: "#1a73e8", letterSpacing: 0.4 }]}>SAVED</Text>
                              </View>
                            </View>
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
                      <TouchableOpacity
                        key={`place-${s.place.placeId}`}
                        onPress={() => pickPlace(s.place)}
                        activeOpacity={0.6}
                        style={{
                          flexDirection: "row", alignItems: "center", gap: 10,
                          paddingHorizontal: 12, paddingVertical: 10,
                          borderBottomWidth: isLast ? 0 : 1, borderBottomColor: "#f1f3f4",
                        }}
                      >
                        <Search size={13} color="#5f6368" strokeWidth={2.2} />
                        <Text style={[txt(600), { fontSize: 13, color: "#202124", flex: 1 }]} numberOfLines={2}>
                          {s.place.description}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ) : null}

              {/* Verify status row */}
              <View style={{
                flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                marginBottom: 16,
              }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
                  {verifyState === "ok" ? (
                    <>
                      <CheckCircle2 size={13} color="#15803d" strokeWidth={2.4} />
                      <Text style={[txt(700), { fontSize: 11, color: "#15803d" }]}>
                        Verified · {lat?.toFixed(4)}, {lng?.toFixed(4)}
                      </Text>
                    </>
                  ) : verifyState === "failed" ? (
                    <>
                      <AlertCircle size={13} color="#b91c1c" strokeWidth={2.4} />
                      <Text style={[txt(700), { fontSize: 11, color: "#b91c1c" }]}>
                        Couldn't find that address
                      </Text>
                    </>
                  ) : (
                    <Text style={[txt(500), { fontSize: 11, color: "#9aa0a6" }]}>
                      Coordinates not verified
                    </Text>
                  )}
                </View>
                <TouchableOpacity
                  onPress={verifyAddress}
                  disabled={!address.trim() || verifying}
                  activeOpacity={0.7}
                  style={{
                    paddingHorizontal: 12, paddingVertical: 6,
                    backgroundColor: address.trim() && !verifying ? "#e8f0fe" : "#f1f3f4",
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: address.trim() && !verifying ? "#bfdbfe" : "transparent",
                  }}
                >
                  {verifying ? (
                    <ActivityIndicator size="small" color="#1a73e8" />
                  ) : (
                    <Text style={[txt(800), { fontSize: 11, color: address.trim() ? "#1a73e8" : "#9aa0a6", letterSpacing: 0.3 }]}>
                      Verify
                    </Text>
                  )}
                </TouchableOpacity>
              </View>

              {/* Appointment window */}
              <Text style={[txt(800), { fontSize: 11, color: "#5f6368", letterSpacing: 0.6, marginBottom: 6 }]}>
                APPOINTMENT WINDOW
              </Text>
              <TouchableOpacity
                onPress={() => setWindowOpen(true)}
                activeOpacity={0.7}
                style={{
                  flexDirection: "row", alignItems: "center", gap: 10,
                  paddingHorizontal: 12, paddingVertical: 12,
                  backgroundColor: "#f1f3f4", borderRadius: 12, marginBottom: 16,
                }}
              >
                <Clock size={15} color="#5f6368" strokeWidth={2.2} />
                <View style={{ flex: 1 }}>
                  <Text style={[txt(600), { fontSize: 11, color: "#5f6368", letterSpacing: 0.4 }]}>FROM</Text>
                  <Text style={[txt(700), { fontSize: 14, color: apptStart ? "#202124" : "#9aa0a6" }]} numberOfLines={1}>
                    {fmtFullDateTime(apptStart)}
                  </Text>
                  <Text style={[txt(600), { fontSize: 11, color: "#5f6368", letterSpacing: 0.4, marginTop: 4 }]}>TO</Text>
                  <Text style={[txt(700), { fontSize: 14, color: apptEnd ? "#202124" : "#9aa0a6" }]} numberOfLines={1}>
                    {fmtFullDateTime(apptEnd)}
                  </Text>
                </View>
              </TouchableOpacity>

              {/* Instructions */}
              <Text style={[txt(800), { fontSize: 11, color: "#5f6368", letterSpacing: 0.6, marginBottom: 6 }]}>
                INSTRUCTIONS
              </Text>
              <TextInput
                value={instructions}
                onChangeText={setInstructions}
                placeholder="Notes for the driver"
                placeholderTextColor="#9aa0a6"
                multiline
                autoCapitalize="sentences"
                style={[txt(500), {
                  fontSize: 13, color: "#3c4043",
                  backgroundColor: "#f1f3f4",
                  borderRadius: 12,
                  paddingHorizontal: 12, paddingVertical: 10,
                  minHeight: 70, textAlignVertical: "top",
                  marginBottom: 12,
                }]}
              />
            </ScrollView>

            <View style={{
              flexDirection: "row", gap: 10,
              paddingHorizontal: 18, paddingTop: 8,
              borderTopWidth: 1, borderTopColor: "#f1f3f4",
            }}>
              <TouchableOpacity
                onPress={onClose}
                activeOpacity={0.7}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 14,
                  backgroundColor: "#f1f3f4",
                  alignItems: "center",
                }}
              >
                <Text style={[txt(800), { fontSize: 14, color: "#3c4043" }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSave}
                activeOpacity={dirty ? 0.85 : 1}
                disabled={!dirty}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 14,
                  backgroundColor: dirty ? "#1a73e8" : "#bfdbfe",
                  alignItems: "center",
                }}
              >
                <Text style={[txt(800), { fontSize: 14, color: "#ffffff", letterSpacing: 0.3 }]}>
                  Apply
                </Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>

      <DateTimePickerSheet
        visible={windowOpen}
        mode="range"
        title="Appointment window"
        initialStart={apptStart ?? ""}
        initialEnd={apptEnd ?? apptStart ?? ""}
        onClose={() => setWindowOpen(false)}
        onSave={(range) => {
          setApptStart(range.start);
          setApptEnd(range.end !== range.start ? range.end : undefined);
          setWindowOpen(false);
        }}
      />
    </Modal>
  );
}
