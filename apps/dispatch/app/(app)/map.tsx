import React, { useMemo, useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useAuth, useOrganization } from "@clerk/clerk-expo";
import WebView from "react-native-webview";
import { ArrowLeft, Truck, Clock, ChevronRight, Route as RouteIcon, X } from "lucide-react-native";
import { fetchAssets } from "@/lib/api";
import { railway } from "@/lib/railway";
import { fetchMotiveLocations, type MotiveLocation } from "@/lib/motive";
import { ActiveLoadsSheet } from "@/components/ActiveLoadsSheet";
import { env } from "@/lib/env";
import { txt } from "@/lib/font";
import type { Asset, Load, LoadStatus, Stop } from "@/lib/types";

interface TruckPin {
  vehicleId: string;
  lat:       number;
  lon:       number;
  color:     string;
  locatedAt: string;
  description: string;
}

interface FocusedRoute {
  loadId:    string;
  color:     string;
  vehicleId: string | null;
  stops:     { lat: number; lng: number; type: string; sequence: number }[];
}

const STATUS_TINT: Record<LoadStatus, { bg: string; fg: string }> = {
  scheduled:  { bg: "#f1f3f4", fg: "#5f6368" },
  assigned:   { bg: "#ede9fe", fg: "#5b21b6" },
  dispatched: { bg: "#e8f0fe", fg: "#1558d6" },
  en_route:   { bg: "#fef3c7", fg: "#92400e" },
  picked_up:  { bg: "#f3e8fd", fg: "#6b21a8" },
  delivered:  { bg: "#e6f4ea", fg: "#15803d" },
  cancelled:  { bg: "#fce8e6", fg: "#b91c1c" },
  tonu:       { bg: "#fef3c7", fg: "#92400e" },
  problem:    { bg: "#fef0e6", fg: "#b85c00" },
};

const STATUS_LABEL: Record<LoadStatus, string> = {
  scheduled:  "Scheduled",
  assigned:   "Assigned",
  dispatched: "Dispatched",
  en_route:   "En Route",
  picked_up:  "Picked Up",
  delivered:  "Delivered",
  cancelled:  "Cancelled",
  tonu:       "TONU",
  problem:    "Problem",
};

const STOP_COLOR: Record<string, string> = {
  pickup:    "#16a34a",
  delivery:  "#dc2626",
  drop_hook: "#2563eb",
  stop:      "#eab308",
  relay:     "#8b5cf6",
};

function fmtAge(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1)  return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function buildHtml(
  trucks: TruckPin[],
  focused: FocusedRoute | null,
  apiKey: string,
): string {
  const trucksJson  = JSON.stringify(trucks);
  const focusedJson = focused ? JSON.stringify(focused) : "null";
  const stopColors  = JSON.stringify(STOP_COLOR);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="initial-scale=1,maximum-scale=1,user-scalable=no" />
<style>
  html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; background: #fff; }
  .truck-pin {
    width: 24px; height: 24px; border-radius: 12px;
    background: var(--c, #1a73e8);
    border: 2.5px solid #fff;
    box-shadow: 0 2px 5px rgba(0,0,0,0.4);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    transition: transform 200ms ease, width 200ms, height 200ms;
  }
  .truck-pin.active { width: 34px; height: 34px; border-radius: 17px; box-shadow: 0 4px 10px rgba(0,0,0,0.55); border-width: 3px; }
  .truck-pin svg { stroke: #fff; }
  .stop-pin {
    width: 22px; height: 22px; border-radius: 11px;
    border: 2.5px solid #fff;
    box-shadow: 0 1px 4px rgba(0,0,0,0.35);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 11px; font-weight: 800;
    font-family: -apple-system,BlinkMacSystemFont,sans-serif;
  }
</style>
</head>
<body>
<div id="map"></div>
<script>
  const trucks = ${trucksJson};
  const focused = ${focusedJson};
  const STOP_COLOR = ${stopColors};
  const post = (msg) => { try { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); } catch(e){} };
  const truckMarkers = {};
  let mapInstance = null;
  let renderer = null;

  const truckSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>';
  const truckSvgActive = '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>';

  function makeOverlay(t, getMap) {
    const overlay = new google.maps.OverlayView();
    let div = null;
    overlay.onAdd = function() {
      div = document.createElement('div');
      div.style.position = 'absolute';
      div.style.transform = 'translate(-50%, -50%)';
      const inner = document.createElement('div');
      inner.className = 'truck-pin';
      inner.style.setProperty('--c', t.color);
      inner.innerHTML = truckSvg;
      inner.addEventListener('click', () => {
        post({ type: 'truck:select', vehicleId: t.vehicleId });
      });
      div.appendChild(inner);
      this.getPanes().overlayMouseTarget.appendChild(div);
      truckMarkers[t.vehicleId] = inner;
    };
    overlay.draw = function() {
      if (!div) return;
      const proj = this.getProjection();
      if (!proj) return;
      const p = proj.fromLatLngToDivPixel(new google.maps.LatLng(t.lat, t.lon));
      div.style.left = p.x + 'px';
      div.style.top  = p.y + 'px';
    };
    overlay.onRemove = function() { if (div && div.parentNode) div.parentNode.removeChild(div); div = null; };
    overlay.setMap(getMap());
  }

  function makeStopMarker(s, idx, total) {
    const overlay = new google.maps.OverlayView();
    let div = null;
    overlay.onAdd = function() {
      div = document.createElement('div');
      div.style.position = 'absolute';
      div.style.transform = 'translate(-50%, -50%)';
      const inner = document.createElement('div');
      inner.className = 'stop-pin';
      inner.style.background = STOP_COLOR[s.type] || '#5f6368';
      inner.textContent = String(idx + 1);
      div.appendChild(inner);
      this.getPanes().overlayMouseTarget.appendChild(div);
    };
    overlay.draw = function() {
      if (!div) return;
      const proj = this.getProjection();
      if (!proj) return;
      const p = proj.fromLatLngToDivPixel(new google.maps.LatLng(s.lat, s.lng));
      div.style.left = p.x + 'px';
      div.style.top  = p.y + 'px';
    };
    overlay.onRemove = function() { if (div && div.parentNode) div.parentNode.removeChild(div); div = null; };
    overlay.setMap(mapInstance);
  }

  window.initMap = function() {
    if (trucks.length === 0 && !focused) {
      document.getElementById('map').innerHTML = '<div style="display:flex;height:100%;align-items:center;justify-content:center;color:#9aa0a6;font-family:-apple-system;font-size:13px;text-align:center;padding:20px">No live truck locations.<br/>Make sure Motive is configured for this org.</div>';
      return;
    }
    const allLats = [...trucks.map(t => t.lat)];
    const allLons = [...trucks.map(t => t.lon)];
    if (focused) {
      focused.stops.forEach(s => { allLats.push(s.lat); allLons.push(s.lng); });
    }
    const minLat = Math.min(...allLats), maxLat = Math.max(...allLats);
    const minLon = Math.min(...allLons), maxLon = Math.max(...allLons);
    const map = new google.maps.Map(document.getElementById('map'), {
      center: { lat: (minLat + maxLat) / 2, lng: (minLon + maxLon) / 2 },
      zoom: 5,
      disableDefaultUI: false, zoomControl: true,
      gestureHandling: 'greedy', clickableIcons: false,
      mapTypeControl: false, streetViewControl: false, fullscreenControl: false,
      styles: [
        { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
        { featureType: 'transit.station.bus', stylers: [{ visibility: 'off' }] },
      ],
    });
    mapInstance = map;

    // Draw the focused route via Google Directions (road-following).
    if (focused && focused.stops.length >= 2) {
      const directionsService = new google.maps.DirectionsService();
      renderer = new google.maps.DirectionsRenderer({
        map,
        suppressMarkers: true,
        preserveViewport: true,
        polylineOptions: { strokeColor: focused.color, strokeWeight: 4.5, strokeOpacity: 0.95 },
      });
      const origin      = { lat: focused.stops[0].lat, lng: focused.stops[0].lng };
      const destination = { lat: focused.stops[focused.stops.length - 1].lat, lng: focused.stops[focused.stops.length - 1].lng };
      const waypoints   = focused.stops.slice(1, -1).map(s => ({ location: { lat: s.lat, lng: s.lng }, stopover: true }));
      directionsService.route(
        { origin, destination, waypoints, travelMode: google.maps.TravelMode.DRIVING },
        (result, status) => {
          if (status === 'OK' && result) renderer.setDirections(result);
          else {
            // Fallback: straight polyline
            const path = focused.stops.map(s => ({ lat: s.lat, lng: s.lng }));
            new google.maps.Polyline({ path, strokeColor: focused.color, strokeWeight: 4, strokeOpacity: 0.95, map });
          }
        },
      );
      // Stop markers (numbered, type-colored)
      focused.stops.forEach((s, i) => makeStopMarker(s, i, focused.stops.length));
    }

    // Trucks
    trucks.forEach(t => makeOverlay(t, () => map));

    // Fit bounds
    if (focused && focused.stops.length > 0) {
      // Tightly fit to focused route stops + the active truck if available
      const bounds = new google.maps.LatLngBounds();
      focused.stops.forEach(s => bounds.extend({ lat: s.lat, lng: s.lng }));
      if (focused.vehicleId) {
        const t = trucks.find(x => x.vehicleId === focused.vehicleId);
        if (t) bounds.extend({ lat: t.lat, lng: t.lon });
      }
      map.fitBounds(bounds, 60);
    } else if (allLats.length > 1) {
      const bounds = new google.maps.LatLngBounds();
      allLats.forEach((la, i) => bounds.extend({ lat: la, lng: allLons[i] }));
      map.fitBounds(bounds, 60);
    } else if (allLats.length === 1) {
      map.setCenter({ lat: allLats[0], lng: allLons[0] });
      map.setZoom(8);
    }

    // Highlight the active truck if any
    if (focused && focused.vehicleId) {
      setTimeout(() => {
        const m = truckMarkers[focused.vehicleId];
        if (m) { m.classList.add('active'); m.innerHTML = truckSvgActive; }
      }, 100);
    }
  };
</script>
<script src="https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=initMap&v=quarterly" async defer></script>
</body>
</html>`;
}

export default function MapScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ assetId?: string }>();
  const focusAssetId = params.assetId ? parseInt(params.assetId, 10) : null;
  const insets = useSafeAreaInsets();
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const orgId = organization?.id;

  const [routesSheetOpen,   setRoutesSheetOpen]   = useState(false);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [focusedLoadId,     setFocusedLoadId]     = useState<string | null>(null);

  const { data: assets = [] } = useQuery({
    queryKey: ["assets", orgId],
    queryFn:  () => fetchAssets(orgId!),
    enabled:  !!orgId,
    staleTime: 5 * 60 * 1000,
  });
  const { data: locations = [], isLoading } = useQuery({
    queryKey: ["motive-locations", orgId],
    queryFn:  () => fetchMotiveLocations(getToken),
    enabled:  !!orgId,
    staleTime: 5 * 60 * 1000,
  });
  // Loads currently in transit by clock time: pickup <= now <= delivery.
  // We pull a 24-hour window (now ± 12h) which covers all overnight runs
  // touching now, then filter precisely client-side. The query persists
  // through the normal cache so it's available offline.
  const { data: inTransitWindow = [] } = useQuery<Load[]>({
    queryKey: ["loads-in-transit-window", orgId],
    queryFn:  async () => {
      const now = new Date();
      const back = new Date(now); back.setHours(now.getHours() - 12);
      const fwd  = new Date(now); fwd.setHours(now.getHours() + 12);
      const pad = (n: number) => String(n).padStart(2, "0");
      const fmt = (d: Date) =>
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
        `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const { loads } = await railway.listLoads({ from: fmt(back), to: fmt(fwd) });
      return loads;
    },
    enabled:  !!orgId,
    staleTime: 60 * 1000,
  });

  // Bucket the now±12h window into three groups for the Today's Loads sheet:
  //   - In transit:     start ≤ now ≤ end
  //   - Pickups soon:   now < start ≤ now + 4h
  //   - Just delivered: now − 4h ≤ end < now
  // Re-derive on every render so a load slides between buckets as time passes.
  const { inTransitArr, pickupsSoonArr, justDeliveredArr } = useMemo(() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const nowNaive = fmt(now);
    const fourFwd  = fmt(new Date(now.getTime() + 4 * 60 * 60 * 1000));
    const fourBack = fmt(new Date(now.getTime() - 4 * 60 * 60 * 1000));

    const inTransit:     Load[] = [];
    const pickupsSoon:   Load[] = [];
    const justDelivered: Load[] = [];
    for (const l of inTransitWindow) {
      const end = l.end ?? l.start;
      if (l.start <= nowNaive && end >= nowNaive)        inTransit.push(l);
      else if (l.start > nowNaive && l.start <= fourFwd) pickupsSoon.push(l);
      else if (end < nowNaive && end >= fourBack)        justDelivered.push(l);
    }
    inTransit.sort((a, b)     => (a.assetName ?? "").localeCompare(b.assetName ?? ""));
    pickupsSoon.sort((a, b)   => a.start.localeCompare(b.start));   // soonest first
    justDelivered.sort((a, b) => (b.end ?? b.start).localeCompare(a.end ?? a.start)); // most recent first
    return { inTransitArr: inTransit, pickupsSoonArr: pickupsSoon, justDeliveredArr: justDelivered };
  }, [inTransitWindow]);

  // Asset-id → in-transit load. Used by the truck-click flow to focus a
  // route when the user taps a truck pin. If a single asset somehow has
  // two loads in flight (rare), keep the first one (already sorted).
  const activeLoadsByAsset = useMemo<Map<number, Load>>(() => {
    const m = new Map<number, Load>();
    for (const l of inTransitArr) if (!m.has(l.assetId)) m.set(l.assetId, l);
    return m;
  }, [inTransitArr]);

  const allTrucks: TruckPin[] = useMemo(
    () => locations
      .map((l: MotiveLocation): TruckPin | null => {
        const asset = assets.find((a) => a.motiveVehicleId === l.vehicleId);
        if (!asset) return null;
        return {
          vehicleId:   l.vehicleId,
          lat:         l.lat,
          lon:         l.lon,
          color:       asset.color ?? "#1a73e8",
          locatedAt:   l.locatedAt,
          description: l.description,
        };
      })
      .filter((t): t is TruckPin => t !== null),
    [locations, assets],
  );

  // Auto-focus when entering with assetId param (from home asset picker)
  React.useEffect(() => {
    if (!focusAssetId) return;
    const asset = assets.find((a) => a.id === focusAssetId);
    if (!asset) return;
    if (asset.motiveVehicleId && !selectedVehicleId) {
      setSelectedVehicleId(asset.motiveVehicleId);
    }
    if (!focusedLoadId) {
      const load = activeLoadsByAsset.get(focusAssetId);
      if (load) setFocusedLoadId(load.id);
    }
  }, [focusAssetId, assets, activeLoadsByAsset, focusedLoadId, selectedVehicleId]);

  const assetById = useMemo(() => {
    const m = new Map<number, Asset>();
    for (const a of assets) m.set(a.id, a);
    return m;
  }, [assets]);

  // Focused load can come from any of the three buckets (in transit, pickups
  // soon, just delivered) — fall back to the full window so a load tapped
  // from the sheet always resolves.
  const focusedLoad: Load | null = useMemo(
    () => focusedLoadId ? inTransitWindow.find((l) => l.id === focusedLoadId) ?? null : null,
    [focusedLoadId, inTransitWindow],
  );

  const focused: FocusedRoute | null = useMemo(() => {
    if (!focusedLoad) return null;
    const stops = focusedLoad.stops
      .filter((s): s is Stop & { lat: number; lng: number } => s.lat != null && s.lng != null)
      .map((s) => ({ lat: s.lat, lng: s.lng, type: s.type, sequence: s.sequence }));
    if (stops.length < 1) return null;
    const asset = assets.find((a) => a.id === focusedLoad.assetId);
    return {
      loadId:    focusedLoad.id,
      color:     asset?.color ?? "#1a73e8",
      vehicleId: asset?.motiveVehicleId ?? null,
      stops,
    };
  }, [focusedLoad, assets]);

  // When a route is focused, hide every other truck so the user is looking at
  // just the asset on that route. The X on the bottom card clears focus and
  // brings everyone back. If the focused load's asset has no Motive vehicle,
  // there'll simply be no truck pins — the route polyline still renders.
  const trucks = focused
    ? allTrucks.filter((t) => t.vehicleId === focused.vehicleId)
    : allTrucks;

  const html = useMemo(
    () => buildHtml(trucks, focused, env.googleMapsKey ?? ""),
    [trucks, focused],
  );

  // The selected truck drives the bottom card. The focused load is independent —
  // if the selected truck happens to be on a load, we draw its route too.
  const selectedAsset: Asset | null = selectedVehicleId
    ? assets.find((a) => a.motiveVehicleId === selectedVehicleId) ?? null
    : (focusedLoad ? assets.find((a) => a.id === focusedLoad.assetId) ?? null : null);
  const selectedTruck = selectedVehicleId
    ? allTrucks.find((t) => t.vehicleId === selectedVehicleId) ?? null
    : null;

  // Every load in the now±12h window assigned to the selected asset, sorted
  // by start time. Powers the clickable list inside the bottom card.
  const selectedAssetLoads: Load[] = useMemo(() => {
    if (!selectedAsset) return [];
    return inTransitWindow
      .filter((l) => l.assetId === selectedAsset.id)
      .sort((a, b) => a.start.localeCompare(b.start));
  }, [selectedAsset, inTransitWindow]);

  const isStandalone = !!focusAssetId;

  return (
    <View style={{ flex: 1, backgroundColor: "#1a73e8" }}>
      {env.googleMapsKey ? (
        <WebView
          source={{ html }}
          originWhitelist={["*"]}
          javaScriptEnabled
          domStorageEnabled
          style={StyleSheet.absoluteFillObject}
          onMessage={(e) => {
            try {
              const msg = JSON.parse(e.nativeEvent.data) as { type: string; vehicleId?: string };
              if (msg.type === "truck:select" && msg.vehicleId) {
                setSelectedVehicleId(msg.vehicleId);
                const asset = assets.find((a) => a.motiveVehicleId === msg.vehicleId);
                const load  = asset ? activeLoadsByAsset.get(asset.id) ?? null : null;
                setFocusedLoadId(load ? load.id : null);
              }
            } catch { /* ignore */ }
          }}
        />
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <Text style={[txt(700), { fontSize: 14, color: "#ffffff", textAlign: "center" }]}>
            Google Maps key not configured.
          </Text>
        </View>
      )}

      {isLoading && allTrucks.length === 0 ? (
        <View style={[StyleSheet.absoluteFillObject, { alignItems: "center", justifyContent: "center" }]}>
          <ActivityIndicator color="#ffffff" />
        </View>
      ) : null}

      {isStandalone ? (
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={12}
          style={{
            position: "absolute",
            top: Math.max(insets.top, 44) + 14,
            left: 14,
            width: 40, height: 40, borderRadius: 20,
            backgroundColor: "rgba(0,0,0,0.6)",
            alignItems: "center", justifyContent: "center",
          }}
        >
          <ArrowLeft size={20} color="#ffffff" strokeWidth={2.6} />
        </TouchableOpacity>
      ) : null}

      {/* Routes button — top-right */}
      <TouchableOpacity
        onPress={() => setRoutesSheetOpen(true)}
        hitSlop={6}
        activeOpacity={0.85}
        style={{
          position: "absolute",
          top: Math.max(insets.top, 44) + 14,
          right: 14,
          flexDirection: "row", alignItems: "center", gap: 6,
          paddingHorizontal: 12, paddingVertical: 8,
          borderRadius: 999,
          backgroundColor: "rgba(0,0,0,0.6)",
        }}
      >
        <RouteIcon size={14} color="#ffffff" strokeWidth={2.4} />
        <Text style={[txt(800), { fontSize: 12, color: "#ffffff", letterSpacing: 0.3 }]}>
          Today's Loads ({inTransitArr.length + pickupsSoonArr.length + justDeliveredArr.length})
        </Text>
      </TouchableOpacity>

      {/* Bottom info card — shows for any selected truck (with or without an active load) */}
      {selectedAsset ? (
        <View style={{
          position: "absolute",
          left: 12, right: 12,
          bottom: insets.bottom + 12,
          backgroundColor: "#ffffff",
          borderRadius: 16,
          padding: 14,
          shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 14, shadowOffset: { width: 0, height: -2 },
        }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={{
              width: 40, height: 40, borderRadius: 12,
              backgroundColor: selectedAsset.color ?? "#1a73e8",
              alignItems: "center", justifyContent: "center",
              flexShrink: 0,
            }}>
              <Truck size={18} color="#ffffff" strokeWidth={2.4} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[txt(800), { fontSize: 15, color: "#202124" }]} numberOfLines={1}>
                {selectedAsset.name}{selectedAsset.unit ? ` · #${selectedAsset.unit}` : ""}
              </Text>
              {selectedTruck ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 }}>
                  <Clock size={11} color="#5f6368" strokeWidth={2.2} />
                  <Text style={[txt(500), { fontSize: 12, color: "#5f6368" }]} numberOfLines={1}>
                    Last seen {fmtAge(selectedTruck.locatedAt)} · {selectedTruck.description}
                  </Text>
                </View>
              ) : null}
            </View>
            <TouchableOpacity
              onPress={() => { setSelectedVehicleId(null); setFocusedLoadId(null); }}
              hitSlop={10}
            >
              <X size={18} color="#9aa0a6" strokeWidth={2.4} />
            </TouchableOpacity>
          </View>

          <View style={{
            marginTop: 12, paddingTop: 12,
            borderTopWidth: 1, borderTopColor: "#f1f3f4",
          }}>
            <Text style={[txt(800), {
              fontSize: 11, letterSpacing: 0.6, color: "#5f6368",
              textTransform: "uppercase", marginBottom: 8,
            }]}>
              Loads (24h)
            </Text>
            {selectedAssetLoads.length === 0 ? (
              <Text style={[txt(500), { fontSize: 12, color: "#9aa0a6" }]}>
                No loads scheduled in the next 12 hours.
              </Text>
            ) : (
              selectedAssetLoads.map((l) => {
                const isFocused = l.id === focusedLoadId;
                const tint = STATUS_TINT[l.status];
                return (
                  <View
                    key={l.id}
                    style={{
                      flexDirection: "row", alignItems: "center", gap: 8,
                      paddingVertical: 8, paddingHorizontal: 10,
                      marginBottom: 4,
                      borderRadius: 10,
                      backgroundColor: isFocused ? "#e8f0fe" : "transparent",
                    }}
                  >
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={() => setFocusedLoadId(l.id)}
                      style={{ flex: 1 }}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 2 }}>
                        <View style={{
                          paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999,
                          backgroundColor: tint.bg,
                        }}>
                          <Text style={[txt(800), { fontSize: 9, color: tint.fg, letterSpacing: 0.3 }]}>
                            {STATUS_LABEL[l.status]}
                          </Text>
                        </View>
                        <Text style={[txt(700), { fontSize: 12, color: "#1a73e8" }]} numberOfLines={1}>
                          {l.loadNum ? `Load #${l.loadNum}` : `Load #${l.internalLoadId ?? "—"}`}
                        </Text>
                      </View>
                      {l.title ? (
                        <Text style={[txt(600), { fontSize: 13, color: "#202124" }]} numberOfLines={1}>
                          {l.title}
                        </Text>
                      ) : null}
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => router.push({ pathname: "/load/[id]", params: { id: l.id } })}
                      hitSlop={8}
                      activeOpacity={0.7}
                    >
                      <ChevronRight size={16} color="#9aa0a6" strokeWidth={2.2} />
                    </TouchableOpacity>
                  </View>
                );
              })
            )}
          </View>
        </View>
      ) : null}

      <ActiveLoadsSheet
        visible={routesSheetOpen}
        inTransit={inTransitArr}
        pickupsSoon={pickupsSoonArr}
        justDelivered={justDeliveredArr}
        assetById={assetById}
        onClose={() => setRoutesSheetOpen(false)}
        onSelect={(load) => {
          setRoutesSheetOpen(false);
          setFocusedLoadId(load.id);
          const asset = assets.find((a) => a.id === load.assetId);
          setSelectedVehicleId(asset?.motiveVehicleId ?? null);
        }}
      />
    </View>
  );
}
