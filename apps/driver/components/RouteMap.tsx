import React, { useMemo, useRef, useState } from "react";
import { View, Text, TouchableOpacity, Modal, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView from "react-native-webview";
import { Maximize2, X, MapPin, Clock } from "lucide-react-native";
import type { Stop, StopType } from "@/lib/types";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

const STOP_COLOR: Record<StopType, string> = {
  pickup:    "#16a34a",
  delivery:  "#dc2626",
  drop:      "#0891b2",
  drop_hook: "#2563eb",
  stop:      "#eab308",
  relay:     "#8b5cf6",
};

const STOP_ACCENT: Record<StopType, { bg: string; fg: string }> = {
  pickup:    { bg: "#dcfce7", fg: "#15803d" },
  delivery:  { bg: "#fee2e2", fg: "#b91c1c" },
  drop:      { bg: "#cffafe", fg: "#0e7490" },
  drop_hook: { bg: "#dbeafe", fg: "#1e40af" },
  stop:      { bg: "#fef9c3", fg: "#854d0e" },
  relay:     { bg: "#f3e8fd", fg: "#6b21a8" },
};

const STOP_LABEL: Record<StopType, string> = {
  pickup:    "Pickup",
  delivery:  "Delivery",
  drop:      "Drop Trailer",
  drop_hook: "Drop & Hook",
  stop:      "Stop",
  relay:     "Relay",
};

const GOOGLE_KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";

interface TruckPos { lat: number; lon: number; color: string }

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

/**
 * Build a Google Maps JS API HTML page with numbered stop markers, a
 * road-following polyline (Directions API), and white check-in dots
 * at any stop the driver has already arrived at. Marker clicks post
 * back to React Native via `window.ReactNativeWebView.postMessage`.
 *
 * `interactive=false` is used for the inline thumbnail to disable
 * gestures and chrome.
 */
function buildMapHtml(
  stops: Stop[],
  apiKey: string,
  interactive: boolean,
  truck: TruckPos | null,
): string {
  const geocoded = stops.filter((s) => typeof s.lat === "number" && typeof s.lng === "number");
  const stopsJson = JSON.stringify(
    geocoded.map((s) => ({
      id: s.id,
      type: s.type,
      lat: s.lat,
      lng: s.lng,
      arrivedLat: s.arrivedLat ?? null,
      arrivedLng: s.arrivedLng ?? null,
      arrivedAt:  s.arrivedAt  ?? null,
    })),
  );
  const colorsJson = JSON.stringify(STOP_COLOR);
  const interactiveStr = interactive ? "true" : "false";
  const truckJson = JSON.stringify(truck);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="initial-scale=1,maximum-scale=1,user-scalable=no" />
<style>
  html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; background: #fff; }
  .pin {
    position: relative;
    width: 28px; height: 28px; border-radius: 50%;
    background: var(--pin-color, #5f6368);
    border: 3px solid #fff;
    box-shadow: 0 2px 6px rgba(0,0,0,0.35);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 11px; font-weight: 800;
    font-family: -apple-system,BlinkMacSystemFont,sans-serif;
    cursor: pointer;
  }
  .pin.active { width: 36px; height: 36px; font-size: 13px; box-shadow: 0 4px 10px rgba(0,0,0,0.55); }
  .checkin {
    width: 18px; height: 18px; border-radius: 50%;
    background: #fff; border: 2.5px solid #16a34a;
    box-shadow: 0 1px 3px rgba(0,0,0,.25);
  }
  .truck-pin {
    width: 28px; height: 28px; border-radius: 50%;
    background: var(--c, #1a73e8);
    border: 3px solid #fff;
    box-shadow: 0 3px 7px rgba(0,0,0,0.45);
    display: flex; align-items: center; justify-content: center;
  }
  .truck-pin svg { stroke: #fff; }
</style>
</head>
<body>
<div id="map"></div>
<script>
  const stops      = ${stopsJson};
  const COLORS     = ${colorsJson};
  const interactive = ${interactiveStr};
  const truck      = ${truckJson};
  const truckSvg   = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>';
  const post = (msg) => { try { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); } catch(e){} };
  const markersById = {};
  let mapInstance = null;
  let pendingFocusIndex = null;

  window.initMap = function() {
    if (stops.length === 0 && !truck) {
      document.getElementById('map').innerHTML = '<div style="display:flex;height:100%;align-items:center;justify-content:center;color:#9aa0a6;font-family:-apple-system;font-size:13px">No coordinates available</div>';
      return;
    }
    const lats = stops.map(s => s.lat), lngs = stops.map(s => s.lng);
    if (truck) { lats.push(truck.lat); lngs.push(truck.lon); }
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);

    const map = new google.maps.Map(document.getElementById('map'), {
      center: { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 },
      zoom: 5,
      disableDefaultUI: !interactive,
      zoomControl: interactive,
      gestureHandling: interactive ? 'greedy' : 'none',
      clickableIcons: false,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      styles: [
        { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
        { featureType: 'transit.station.bus', stylers: [{ visibility: 'off' }] },
      ],
    });
    mapInstance = map;

    function makeOverlay(position, html, onClick) {
      const overlay = new google.maps.OverlayView();
      let div = null;
      overlay.onAdd = function() {
        div = document.createElement('div');
        div.style.position = 'absolute';
        div.style.transform = 'translate(-50%, -50%)';
        div.innerHTML = html;
        if (onClick) div.firstElementChild.addEventListener('click', onClick);
        this.getPanes().overlayMouseTarget.appendChild(div);
      };
      overlay.draw = function() {
        if (!div) return;
        const proj = this.getProjection();
        if (!proj) return;
        const p = proj.fromLatLngToDivPixel(new google.maps.LatLng(position.lat, position.lng));
        div.style.left = p.x + 'px';
        div.style.top  = p.y + 'px';
      };
      overlay.onRemove = function() { if (div && div.parentNode) div.parentNode.removeChild(div); div = null; };
      overlay.getElement = function() { return div ? div.firstElementChild : null; };
      overlay.setMap(map);
      return overlay;
    }

    stops.forEach((s, i) => {
      const color = COLORS[s.type] || '#5f6368';
      const html = '<div class="pin" style="--pin-color:' + color + '">' + (i + 1) + '</div>';
      const ov = makeOverlay({ lat: s.lat, lng: s.lng }, html, interactive ? () => post({ type: 'stop:select', index: i }) : null);
      markersById[s.id] = ov;

      if (s.arrivedLat != null && s.arrivedLng != null) {
        makeOverlay({ lat: s.arrivedLat, lng: s.arrivedLng }, '<div class="checkin"></div>', null);
      }
    });

    // Live truck marker — colored circle (asset color) with a white truck
    // glyph. Sits above stops so a co-located pin doesn't fully hide it.
    if (truck) {
      const truckHtml = '<div class="truck-pin" style="--c:' + truck.color + '">' + truckSvg + '</div>';
      makeOverlay({ lat: truck.lat, lng: truck.lon }, truckHtml, null);
    }

    if (stops.length >= 2) {
      const directionsService = new google.maps.DirectionsService();
      const renderer = new google.maps.DirectionsRenderer({
        map,
        suppressMarkers: true,
        preserveViewport: true,
        polylineOptions: { strokeColor: '#1a73e8', strokeWeight: 4, strokeOpacity: 0.9 },
      });
      const origin      = { lat: stops[0].lat, lng: stops[0].lng };
      const destination = { lat: stops[stops.length - 1].lat, lng: stops[stops.length - 1].lng };
      const waypoints   = stops.slice(1, -1).map(s => ({ location: { lat: s.lat, lng: s.lng }, stopover: true }));
      directionsService.route(
        { origin, destination, waypoints, travelMode: google.maps.TravelMode.DRIVING },
        (result, status) => {
          if (status === 'OK' && result) {
            renderer.setDirections(result);
          } else {
            // Fallback to a straight polyline through the stops.
            const path = stops.map(s => ({ lat: s.lat, lng: s.lng }));
            new google.maps.Polyline({ path, strokeColor: '#1a73e8', strokeWeight: 4, strokeOpacity: 0.9, map });
          }
        },
      );
      const bounds = new google.maps.LatLngBounds();
      stops.forEach(s => bounds.extend({ lat: s.lat, lng: s.lng }));
      map.fitBounds(bounds, 50);
    } else {
      map.setCenter({ lat: stops[0].lat, lng: stops[0].lng });
      map.setZoom(10);
    }

    post({ type: 'ready' });
    if (pendingFocusIndex !== null) { focusStop(pendingFocusIndex); pendingFocusIndex = null; }
  };

  function focusStop(index) {
    const s = stops[index];
    if (!s || !mapInstance) return;
    mapInstance.panTo({ lat: s.lat, lng: s.lng });
    mapInstance.setZoom(13);
    Object.keys(markersById).forEach(id => {
      const el = markersById[id].getElement();
      if (el) el.classList.remove('active');
    });
    const activeEl = markersById[s.id] && markersById[s.id].getElement();
    if (activeEl) activeEl.classList.add('active');
  }

  document.addEventListener('rn:focus-stop', (e) => {
    if (!mapInstance) { pendingFocusIndex = e.detail.index; return; }
    focusStop(e.detail.index);
  });
</script>
<script src="https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=initMap&libraries=geometry&v=quarterly" async defer></script>
</body>
</html>`;
}

type Props = {
  stops:    Stop[];
  height?:  number;
  /** Live truck position to overlay on the route. Hidden when null. */
  truckLat?:    number | null;
  truckLng?:    number | null;
  /** Asset color used to tint the truck pin. Falls back to brand blue. */
  assetColor?:  string | null;
};

export function RouteMap({ stops, height = 220, truckLat, truckLng, assetColor }: Props) {
  const [fullscreen, setFullscreen]   = useState(false);
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const insets = useSafeAreaInsets();
  const fullscreenWebRef = useRef<WebView | null>(null);

  const geocoded = useMemo(
    () => stops.filter((s) => typeof s.lat === "number" && typeof s.lng === "number"),
    [stops],
  );

  const thumbnailHtml = useMemo(() => {
    const truck: TruckPos | null = (truckLat != null && truckLng != null)
      ? { lat: truckLat, lon: truckLng, color: assetColor ?? "#1a73e8" }
      : null;
    return buildMapHtml(stops, GOOGLE_KEY, false, truck);
  }, [stops, truckLat, truckLng, assetColor]);

  const fullscreenHtml = useMemo(() => {
    const truck: TruckPos | null = (truckLat != null && truckLng != null)
      ? { lat: truckLat, lon: truckLng, color: assetColor ?? "#1a73e8" }
      : null;
    return buildMapHtml(stops, GOOGLE_KEY, true, truck);
  }, [stops, truckLat, truckLng, assetColor]);

  function focusStopInWebview(index: number) {
    const js = `document.dispatchEvent(new CustomEvent('rn:focus-stop',{detail:{index:${index}}})); true;`;
    fullscreenWebRef.current?.injectJavaScript(js);
  }

  React.useEffect(() => {
    if (fullscreen) {
      const t = setTimeout(() => focusStopInWebview(selectedIdx), 350);
      return () => clearTimeout(t);
    }
  }, [fullscreen, selectedIdx]);

  if (!GOOGLE_KEY) {
    return (
      <View style={{ height, backgroundColor: "#fef3c7", borderRadius: 14, alignItems: "center", justifyContent: "center", padding: 16 }}>
        <Text style={[txt(700), { fontSize: 13, color: "#92400e", textAlign: "center" }]}>
          Google Maps key not configured (EXPO_PUBLIC_GOOGLE_MAPS_API_KEY)
        </Text>
      </View>
    );
  }

  if (geocoded.length === 0) {
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

  const selectedStop = geocoded[selectedIdx] ?? null;
  const globalIdx    = selectedStop ? stops.indexOf(selectedStop) : -1;

  return (
    <>
      {/* Thumbnail */}
      <TouchableOpacity
        activeOpacity={0.95}
        onPress={() => { setSelectedIdx(0); setFullscreen(true); }}
        style={{ height, borderRadius: 14, overflow: "hidden", borderWidth: 1, borderColor: "#e8eaed" }}
      >
        <WebView
          source={{ html: thumbnailHtml }}
          originWhitelist={["*"]}
          javaScriptEnabled
          domStorageEnabled
          scrollEnabled={false}
          style={{ flex: 1, backgroundColor: "#ffffff" }}
        />
        <View pointerEvents="none" style={{
          position: "absolute", top: 10, right: 10,
          backgroundColor: "rgba(0,0,0,0.5)", borderRadius: 8, padding: 6,
        }}>
          <Maximize2 size={14} color="#ffffff" strokeWidth={2.2} />
        </View>
      </TouchableOpacity>

      {/* Fullscreen */}
      <Modal
        visible={fullscreen}
        animationType="slide"
        statusBarTranslucent
        presentationStyle="overFullScreen"
        onRequestClose={() => setFullscreen(false)}
      >
        <View style={{ flex: 1, backgroundColor: "#1a73e8" }}>
          <WebView
            ref={fullscreenWebRef}
            source={{ html: fullscreenHtml }}
            originWhitelist={["*"]}
            javaScriptEnabled
            domStorageEnabled
            style={StyleSheet.absoluteFillObject}
            onMessage={(e) => {
              try {
                const msg = JSON.parse(e.nativeEvent.data);
                if (msg.type === "stop:select" && typeof msg.index === "number") {
                  setSelectedIdx(msg.index);
                }
              } catch { /* ignore */ }
            }}
          />

          <TouchableOpacity
            onPress={() => setFullscreen(false)}
            hitSlop={12}
            style={{
              position: "absolute",
              top: Math.max(insets.top, 44) + 14,
              right: 14,
              width: 40, height: 40, borderRadius: 20,
              backgroundColor: "rgba(0,0,0,0.6)",
              alignItems: "center", justifyContent: "center",
              shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
            }}
          >
            <X size={20} color="#ffffff" strokeWidth={2.6} />
          </TouchableOpacity>

          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              bottom: insets.bottom + 12 + 92,
              left: 0, right: 0,
              alignItems: "center",
            }}
          >
            <View style={{ paddingHorizontal: 12, paddingVertical: 6, backgroundColor: "rgba(0,0,0,0.55)", borderRadius: 999 }}>
              <Text style={[txt(700), { fontSize: 12, color: "#ffffff" }]}>
                {geocoded.length} stop{geocoded.length !== 1 ? "s" : ""}
              </Text>
            </View>
          </View>

          {selectedStop ? (
            <View
              style={{
                position: "absolute",
                left: 12, right: 12,
                bottom: insets.bottom + 12,
                backgroundColor: "#ffffff",
                borderRadius: 16,
                padding: 14,
                shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 14, shadowOffset: { width: 0, height: -2 },
              }}
            >
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
                  <View style={{ alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: STOP_ACCENT[selectedStop.type].bg, marginBottom: 3 }}>
                    <Text style={[txt(800), { fontSize: 10, color: STOP_ACCENT[selectedStop.type].fg, letterSpacing: 0.5 }]}>
                      {STOP_LABEL[selectedStop.type].toUpperCase()}
                    </Text>
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
                    onPress={() => setSelectedIdx((i) => (i > 0 ? i - 1 : i))}
                    disabled={selectedIdx === 0}
                    style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: selectedIdx === 0 ? "#f1f3f4" : "#e8f0fe", alignItems: "center", justifyContent: "center" }}
                  >
                    <Text style={[txt(800), { fontSize: 16, color: selectedIdx === 0 ? "#c0c4c8" : "#1a73e8" }]}>‹</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setSelectedIdx((i) => (i < geocoded.length - 1 ? i + 1 : i))}
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
      </Modal>
    </>
  );
}
