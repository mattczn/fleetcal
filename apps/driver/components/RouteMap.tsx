import React, { useMemo, useState } from "react";
import { View, Text, TouchableOpacity, Modal, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import MapView, { Marker, Polyline, PROVIDER_DEFAULT } from "react-native-maps";
import { useQuery } from "@tanstack/react-query";
import { fetchRoadPolyline } from "@/lib/api/directions";
import { Maximize2, X, MapPin, Clock } from "lucide-react-native";
import type { Stop } from "@/lib/types";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

const STOP_COLOR: Record<Stop["type"], string> = {
  pickup:    "#16a34a",
  delivery:  "#dc2626",
  drop_hook: "#2563eb",
  stop:      "#eab308",
  relay:     "#8b5cf6",
};

const STOP_ACCENT: Record<Stop["type"], { bg: string; fg: string }> = {
  pickup:    { bg: "#dcfce7", fg: "#15803d" },
  delivery:  { bg: "#fee2e2", fg: "#b91c1c" },
  drop_hook: { bg: "#dbeafe", fg: "#1e40af" },
  stop:      { bg: "#fef9c3", fg: "#854d0e" },
  relay:     { bg: "#f3e8fd", fg: "#6b21a8" },
};

const STOP_LABEL: Record<Stop["type"], string> = {
  pickup:    "Pickup",
  delivery:  "Delivery",
  drop_hook: "Drop & Hook",
  stop:      "Stop",
  relay:     "Relay",
};

function fmtTime(iso?: string): string {
  if (!iso) return "";
  const t = iso.slice(11, 16);
  if (!t) return "";
  const [hStr, mStr] = t.split(":");
  const h = parseInt(hStr, 10);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12  = h % 12 || 12;
  return `${h12}:${mStr} ${ampm}`;
}

type Props = {
  stops:   Stop[];
  height?: number;
};

export function RouteMap({ stops, height = 220 }: Props) {
  const [fullscreen, setFullscreen]   = useState(false);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const insets = useSafeAreaInsets();

  const geocoded = useMemo(
    () => stops.filter((s) => typeof s.lat === "number" && typeof s.lng === "number"),
    [stops],
  );

  const waypoints = useMemo(
    () => geocoded.map((s) => ({ lat: s.lat!, lng: s.lng! })),
    [geocoded],
  );

  const { data: route } = useQuery({
    queryKey: ["road-polyline", waypoints.map((w) => `${w.lat},${w.lng}`).join("|")],
    queryFn:  () => fetchRoadPolyline(waypoints),
    enabled:  waypoints.length >= 2,
    staleTime: 60 * 60 * 1000,
  });

  const lineCoords = route?.coords
    ?? geocoded.map((s) => ({ latitude: s.lat!, longitude: s.lng! }));

  const region = useMemo(() => {
    if (lineCoords.length === 0) return null;
    const lats = lineCoords.map((c) => c.latitude);
    const lngs = lineCoords.map((c) => c.longitude);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const latDelta = Math.max((maxLat - minLat) * 1.5, 0.4);
    const lngDelta = Math.max((maxLng - minLng) * 1.5, 0.4);
    return {
      latitude:       (minLat + maxLat) / 2,
      longitude:      (minLng + maxLng) / 2,
      latitudeDelta:  latDelta,
      longitudeDelta: lngDelta,
    };
  }, [lineCoords]);

  if (geocoded.length === 0 || !region) {
    return (
      <View
        style={{
          height,
          backgroundColor: "#f1f3f4",
          borderRadius: 14,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1, borderColor: "#e8eaed",
        }}
      >
        <Text style={[txt(600), { fontSize: 13, color: "#9aa0a6" }]}>
          No coordinates available for this route
        </Text>
      </View>
    );
  }

  const selectedStop = selectedIdx !== null ? geocoded[selectedIdx] : null;
  const globalIdx    = selectedStop ? stops.indexOf(selectedStop) : -1;

  return (
    <>
      {/* ── Thumbnail ── */}
      <TouchableOpacity
        activeOpacity={0.95}
        onPress={() => { setSelectedIdx(0); setFullscreen(true); }}
        style={{ height, borderRadius: 14, overflow: "hidden", borderWidth: 1, borderColor: "#e8eaed" }}
      >
        <MapView
          provider={PROVIDER_DEFAULT}
          style={{ flex: 1 }}
          initialRegion={region}
          scrollEnabled={false}
          zoomEnabled={false}
          pitchEnabled={false}
          rotateEnabled={false}
          showsCompass={false}
          showsPointsOfInterests={false}
          pointerEvents="none"
        >
          <Polyline coordinates={lineCoords} strokeColor="#1a73e8" strokeWidth={4} />
          {geocoded.map((s, i) => (
            <Marker
              key={s.id}
              coordinate={{ latitude: s.lat!, longitude: s.lng! }}
              anchor={{ x: 0.5, y: 0.5 }}
            >
              <View style={{
                width: 26, height: 26, borderRadius: 13,
                backgroundColor: STOP_COLOR[s.type] ?? "#5f6368",
                borderWidth: 3, borderColor: "#ffffff",
                alignItems: "center", justifyContent: "center",
                shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 4,
                shadowOffset: { width: 0, height: 2 },
              }}>
                <Text style={[txt(800), { fontSize: 11, color: "#ffffff" }]}>{i + 1}</Text>
              </View>
            </Marker>
          ))}
        </MapView>

        {/* Expand badge */}
        <View style={{
          position: "absolute", top: 10, right: 10,
          backgroundColor: "rgba(0,0,0,0.5)",
          borderRadius: 8, padding: 6,
        }}>
          <Maximize2 size={14} color="#ffffff" strokeWidth={2.2} />
        </View>
      </TouchableOpacity>

      {/* ── Fullscreen modal ── */}
      <Modal
        visible={fullscreen}
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setFullscreen(false)}
      >
        <View style={{ flex: 1, backgroundColor: "#1a73e8" }}>
        {/* Map fills entire screen */}
        <MapView
          provider={PROVIDER_DEFAULT}
          style={StyleSheet.absoluteFillObject}
          initialRegion={region}
          showsCompass={false}
          showsPointsOfInterests={false}
          pitchEnabled={false}
          rotateEnabled={false}
        >
          <Polyline coordinates={lineCoords} strokeColor="#1a73e8" strokeWidth={5} />
          {geocoded.map((s, i) => {
            const color    = STOP_COLOR[s.type] ?? "#5f6368";
            const isActive = selectedIdx === i;
            return (
              <Marker
                key={s.id}
                coordinate={{ latitude: s.lat!, longitude: s.lng! }}
                anchor={{ x: 0.5, y: 0.5 }}
                onPress={() => setSelectedIdx(i)}
                tracksViewChanges={false}
              >
                <View style={{
                  width: isActive ? 42 : 32,
                  height: isActive ? 42 : 32,
                  borderRadius: isActive ? 21 : 16,
                  backgroundColor: color,
                  borderWidth: isActive ? 4 : 3,
                  borderColor: "#ffffff",
                  alignItems: "center", justifyContent: "center",
                  shadowColor: "#000",
                  shadowOpacity: isActive ? 0.45 : 0.25,
                  shadowRadius: isActive ? 8 : 4,
                  shadowOffset: { width: 0, height: 2 },
                }}>
                  <Text style={[txt(800), { fontSize: isActive ? 15 : 12, color: "#ffffff" }]}>
                    {i + 1}
                  </Text>
                </View>
              </Marker>
            );
          })}
        </MapView>

        {/*
          Overlay column: flex: 1 with pointerEvents="box-none" so the map
          behind it receives all touches except on the actual UI elements.
          Flex column pushes controls to the bottom via a touch-transparent spacer.
        */}
        <View style={{ flex: 1 }} pointerEvents="box-none">
          {/* Touch-transparent spacer — map shows through here */}
          <View style={{ flex: 1 }} pointerEvents="box-none" />

          {/* Close button — top right, inside spacer via absolute */}
          <View pointerEvents="box-none" style={{ position: "absolute", top: insets.top + 8, right: 12 }}>
            <TouchableOpacity
              onPress={() => setFullscreen(false)}
              style={{
                width: 38, height: 38, borderRadius: 19,
                backgroundColor: "rgba(0,0,0,0.55)",
                alignItems: "center", justifyContent: "center",
              }}
            >
              <X size={18} color="#ffffff" strokeWidth={2.4} />
            </TouchableOpacity>
          </View>

          {/* Bottom controls — normal flow, only as tall as content */}
          <View style={{ paddingBottom: insets.bottom }}>
            {/* Stop count pill */}
            <View pointerEvents="box-none" style={{ flexDirection: "row", justifyContent: "center", paddingBottom: 6 }}>
              <View style={{ paddingHorizontal: 12, paddingVertical: 6, backgroundColor: "rgba(0,0,0,0.55)", borderRadius: 999 }}>
                <Text style={[txt(700), { fontSize: 12, color: "#ffffff" }]}>
                  {geocoded.length} stop{geocoded.length !== 1 ? "s" : ""}
                </Text>
              </View>
            </View>

            {selectedStop ? (
              <View style={{
                margin: 12, marginTop: 0,
                backgroundColor: "#ffffff",
                borderRadius: 16,
                padding: 16,
                shadowColor: "#000",
                shadowOpacity: 0.18,
                shadowRadius: 12,
                shadowOffset: { width: 0, height: -2 },
              }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                  <View style={{
                    width: 44, height: 44, borderRadius: 12,
                    backgroundColor: STOP_COLOR[selectedStop.type] ?? "#5f6368",
                    alignItems: "center", justifyContent: "center",
                    flexShrink: 0,
                  }}>
                    <Text style={[txt(800), { fontSize: 18, color: "#ffffff" }]}>{globalIdx + 1}</Text>
                  </View>

                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 3 }}>
                      <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: STOP_ACCENT[selectedStop.type].bg }}>
                        <Text style={[txt(800), { fontSize: 10, color: STOP_ACCENT[selectedStop.type].fg, letterSpacing: 0.5 }]}>
                          {STOP_LABEL[selectedStop.type].toUpperCase()}
                        </Text>
                      </View>
                    </View>

                    <Text style={[txt(700), { fontSize: 15, color: "#202124" }]} numberOfLines={1}>
                      {selectedStop.facilityName ?? selectedStop.city ?? selectedStop.address ?? "—"}
                    </Text>

                    {(selectedStop.address || selectedStop.city) ? (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 }}>
                        <MapPin size={11} color="#5f6368" strokeWidth={2.2} />
                        <Text style={[txt(500), { fontSize: 12, color: "#5f6368" }]} numberOfLines={1}>
                          {selectedStop.address ?? selectedStop.city}
                        </Text>
                      </View>
                    ) : null}

                    {selectedStop.apptStart ? (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 3 }}>
                        <Clock size={11} color="#5f6368" strokeWidth={2.2} />
                        <Text style={[txt(500), { fontSize: 12, color: "#5f6368" }]}>
                          {selectedStop.apptEnd && selectedStop.apptEnd !== selectedStop.apptStart
                            ? `${fmtTime(selectedStop.apptStart)} – ${fmtTime(selectedStop.apptEnd)}`
                            : fmtTime(selectedStop.apptStart)}
                        </Text>
                      </View>
                    ) : null}
                  </View>

                  <View style={{ flexDirection: "row", gap: 6 }}>
                    <TouchableOpacity
                      onPress={() => setSelectedIdx((i) => (i !== null && i > 0 ? i - 1 : i))}
                      disabled={selectedIdx === 0}
                      style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: selectedIdx === 0 ? "#f1f3f4" : "#e8f0fe", alignItems: "center", justifyContent: "center" }}
                    >
                      <Text style={[txt(800), { fontSize: 16, color: selectedIdx === 0 ? "#c0c4c8" : "#1a73e8" }]}>‹</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => setSelectedIdx((i) => (i !== null && i < geocoded.length - 1 ? i + 1 : i))}
                      disabled={selectedIdx === geocoded.length - 1}
                      style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: selectedIdx === geocoded.length - 1 ? "#f1f3f4" : "#e8f0fe", alignItems: "center", justifyContent: "center" }}
                    >
                      <Text style={[txt(800), { fontSize: 16, color: selectedIdx === geocoded.length - 1 ? "#c0c4c8" : "#1a73e8" }]}>›</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {selectedStop.instructions ? (
                  <Text style={[txt(500), { fontSize: 12, color: "#5f6368", marginTop: 10, lineHeight: 18 }]}>
                    {selectedStop.instructions}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>
        </View>
      </Modal>
    </>
  );
}
