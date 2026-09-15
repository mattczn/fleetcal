/**
 * Shift trail map — where someone was while they were on the clock.
 *
 * Opened by tapping a shift on the timesheet. Reviewer-only: the caller
 * gates on `timesheet.view_all`, and the API refuses the pings for
 * someone else's shift without it.
 *
 * Rendered through a WebView + the Google Maps JS API rather than
 * react-native-maps, matching RouteMap and TrucksMap. That is a
 * deliberate choice and not just consistency: it keeps this feature
 * pure JavaScript, so it ships as an OTA update instead of requiring
 * another App Store round trip.
 *
 * ── Reading the trail honestly ────────────────────────────────────────
 *
 * Pings are samples roughly every 30 minutes, NOT a continuous track.
 * Straight lines between them are the shortest path between two
 * observations, not the route taken — the map draws them dashed and
 * says so, because a solid polyline reads as "this is where he drove"
 * and would be a claim the data cannot support.
 *
 * Two absences look identical on a map and mean opposite things, so
 * both are labeled rather than left to interpretation:
 *   · tracking stopped (permission downgraded) — banner, and the shift
 *     carries trackingStoppedAt
 *   · genuinely no samples yet — empty state
 */
import React, { useMemo } from "react";
import {
  Modal, View, Text, TouchableOpacity, Pressable, ActivityIndicator,
} from "react-native";
import WebView from "react-native-webview";
import { useQuery } from "@tanstack/react-query";
import { X, MapPinOff, MapPin } from "lucide-react-native";
import type { TimesheetShift } from "@fleetcal/types";
import { txt } from "@/lib/font";
import { env } from "@/lib/env";
import { railway } from "@/lib/railway";

interface Props {
  visible: boolean;
  shift:   TimesheetShift | null;
  onClose: () => void;
}

function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

interface MapPoint {
  lat: number;
  lng: number;
  label: string;
  kind: "in" | "out" | "ping";
}

function buildHtml(points: MapPoint[], apiKey: string): string {
  const json = JSON.stringify(points);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="initial-scale=1,maximum-scale=1,user-scalable=no" />
<style>
  html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; background: #fff; }
  .dot {
    width: 14px; height: 14px; border-radius: 50%;
    background: #1a73e8; border: 2.5px solid #fff;
    box-shadow: 0 1px 4px rgba(0,0,0,.35);
  }
  .endpoint {
    width: 26px; height: 26px; border-radius: 50%;
    border: 3px solid #fff;
    box-shadow: 0 2px 6px rgba(0,0,0,.4);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font: 800 10px -apple-system, BlinkMacSystemFont, sans-serif;
  }
  .in  { background: #1e8e3e; }
  .out { background: #ea4335; }
</style>
</head>
<body>
<div id="map"></div>
<script>
  const points = ${json};
  window.initMap = function () {
    const el = document.getElementById('map');
    if (!points.length) {
      el.innerHTML = '<div style="display:flex;height:100%;align-items:center;justify-content:center;color:#9aa0a6;font-family:-apple-system;font-size:13px">No locations recorded</div>';
      return;
    }
    const map = new google.maps.Map(el, {
      mapTypeControl: false, streetViewControl: false, fullscreenControl: false,
      zoomControl: true, clickableIcons: false,
    });
    const bounds = new google.maps.LatLngBounds();

    // Dashed, not solid. These are samples ~30 min apart; a solid line
    // would imply a surveyed route we never observed.
    if (points.length > 1) {
      new google.maps.Polyline({
        map,
        path: points.map(p => ({ lat: p.lat, lng: p.lng })),
        strokeOpacity: 0,
        icons: [{
          icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.55, strokeColor: '#1a73e8', scale: 3 },
          offset: '0', repeat: '14px',
        }],
      });
    }

    points.forEach((p) => {
      const div = document.createElement('div');
      if (p.kind === 'ping') {
        div.className = 'dot';
      } else {
        div.className = 'endpoint ' + p.kind;
        div.textContent = p.kind === 'in' ? 'IN' : 'OUT';
      }
      const marker = new google.maps.marker.AdvancedMarkerElement({
        map, position: { lat: p.lat, lng: p.lng }, content: div,
        zIndex: p.kind === 'ping' ? 1 : 2,
      });
      const info = new google.maps.InfoWindow({ content: '<div style="font:600 12px -apple-system;padding:2px 4px">' + p.label + '</div>' });
      div.addEventListener('click', () => info.open({ map, anchor: marker }));
      bounds.extend({ lat: p.lat, lng: p.lng });
    });

    map.fitBounds(bounds, 48);
    // A single point fits to max zoom, which looks broken. Pull back.
    google.maps.event.addListenerOnce(map, 'idle', () => {
      if (map.getZoom() > 16) map.setZoom(16);
    });
  };
</script>
<script src="https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=initMap&libraries=marker&loading=async&v=quarterly" async defer></script>
</body>
</html>`;
}

export function ShiftMapSheet({ visible, shift, onClose }: Props) {
  const apiKey = env.googleMapsKey ?? "";

  const pingsQ = useQuery({
    queryKey: ["timesheet", "pings", shift?.id],
    queryFn:  async () => (await railway.listTimesheetPings(shift!.id)).pings,
    enabled:  visible && !!shift?.id,
  });

  const points = useMemo<MapPoint[]>(() => {
    if (!shift) return [];
    const out: MapPoint[] = [];
    if (shift.startLat != null && shift.startLng != null) {
      out.push({ lat: shift.startLat, lng: shift.startLng, kind: "in", label: `Clocked in ${fmtClock(shift.startedAt)}` });
    }
    for (const p of pingsQ.data ?? []) {
      out.push({ lat: p.lat, lng: p.lng, kind: "ping", label: fmtClock(p.at) });
    }
    if (shift.endLat != null && shift.endLng != null && shift.endedAt) {
      out.push({ lat: shift.endLat, lng: shift.endLng, kind: "out", label: `Clocked out ${fmtClock(shift.endedAt)}` });
    }
    return out;
  }, [shift, pingsQ.data]);

  const html = useMemo(() => buildHtml(points, apiKey), [points, apiKey]);
  const pingCount = pingsQ.data?.length ?? 0;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: "#ffffff",
            borderTopLeftRadius: 18, borderTopRightRadius: 18,
            height: "86%", overflow: "hidden",
          }}
        >
          {/* Header */}
          <View style={{
            flexDirection: "row", alignItems: "center", gap: 10,
            paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12,
            borderBottomWidth: 1, borderBottomColor: "#e8eaed",
          }}>
            <View style={{ flex: 1 }}>
              <Text style={[txt(800), { fontSize: 16, color: "#202124" }]} numberOfLines={1}>
                {shift?.userName ?? "Shift"}
              </Text>
              {shift ? (
                <Text style={[txt(600), { fontSize: 12, color: "#5f6368", marginTop: 2 }]}>
                  {fmtDay(shift.startedAt)} · {fmtClock(shift.startedAt)}
                  {shift.endedAt ? ` – ${fmtClock(shift.endedAt)}` : " – running"}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={20} color="#5f6368" strokeWidth={2.2} />
            </TouchableOpacity>
          </View>

          {/* Tracking-gap banner. Without this an empty or short trail
              reads as "he never moved" when the truth is "the phone
              stopped reporting". */}
          {shift?.trackingStoppedAt ? (
            <View style={{
              flexDirection: "row", alignItems: "center", gap: 8,
              paddingHorizontal: 16, paddingVertical: 10,
              backgroundColor: "#fef7e0",
            }}>
              <MapPinOff size={14} color="#b06000" strokeWidth={2.4} />
              <Text style={[txt(600), { fontSize: 12, color: "#b06000", flex: 1 }]}>
                Location tracking stopped at {fmtClock(shift.trackingStoppedAt)} — the trail is incomplete after that.
              </Text>
            </View>
          ) : null}

          {/* Map */}
          <View style={{ flex: 1 }}>
            {!apiKey ? (
              <Centered text="Map unavailable — no Google Maps key configured." />
            ) : pingsQ.isLoading ? (
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                <ActivityIndicator color="#1a73e8" />
              </View>
            ) : points.length === 0 ? (
              <Centered text={
                shift?.trackingStoppedAt
                  ? "No locations were recorded for this shift."
                  : "No locations recorded yet."
              } />
            ) : (
              <WebView
                originWhitelist={["*"]}
                source={{ html }}
                style={{ flex: 1 }}
                javaScriptEnabled
                domStorageEnabled
                setSupportMultipleWindows={false}
              />
            )}
          </View>

          {/* Footer legend — states plainly what the line is and isn't. */}
          <View style={{
            flexDirection: "row", alignItems: "center", gap: 6,
            paddingHorizontal: 16, paddingVertical: 12,
            borderTopWidth: 1, borderTopColor: "#e8eaed",
          }}>
            <MapPin size={13} color="#5f6368" strokeWidth={2.4} />
            <Text style={[txt(600), { fontSize: 11, color: "#5f6368", flex: 1 }]}>
              {pingCount} location{pingCount === 1 ? "" : "s"} · sampled about every 30 min, not a continuous route
            </Text>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Centered({ text }: { text: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 }}>
      <Text style={[txt(600), { fontSize: 13, color: "#9aa0a6", textAlign: "center" }]}>
        {text}
      </Text>
    </View>
  );
}
