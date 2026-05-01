import React, { useMemo } from "react";
import { View, Text, ActivityIndicator, TouchableOpacity } from "react-native";
import WebView from "react-native-webview";
import { useQuery } from "@tanstack/react-query";
import { useAuth, useOrganization } from "@clerk/clerk-expo";
import { useRouter } from "expo-router";
import { Maximize2 } from "lucide-react-native";
import { fetchMotiveLocations, type MotiveLocation } from "@/lib/motive";
import { fetchAssets } from "@/lib/api";
import { env } from "@/lib/env";
import { txt } from "@/lib/font";

interface TruckPin {
  vehicleId: string;
  lat: number;
  lon: number;
  color: string;
}

function buildHtml(trucks: TruckPin[], apiKey: string): string {
  const json = JSON.stringify(trucks);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="initial-scale=1,maximum-scale=1,user-scalable=no" />
<style>
  html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; background: #fff; }
  .truck-pin {
    width: 20px; height: 20px; border-radius: 10px;
    background: var(--c, #1a73e8);
    border: 2.5px solid #fff;
    box-shadow: 0 2px 5px rgba(0,0,0,0.35);
    display: flex; align-items: center; justify-content: center;
  }
</style>
</head>
<body>
<div id="map"></div>
<script>
  const trucks = ${json};
  const truckSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>';
  window.initMap = function() {
    if (trucks.length === 0) {
      document.getElementById('map').innerHTML = '<div style="display:flex;height:100%;align-items:center;justify-content:center;color:#9aa0a6;font-family:-apple-system;font-size:13px">No truck locations available</div>';
      return;
    }
    const lats = trucks.map(t => t.lat), lons = trucks.map(t => t.lon);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLon = Math.min(...lons), maxLon = Math.max(...lons);
    const map = new google.maps.Map(document.getElementById('map'), {
      center: { lat: (minLat + maxLat) / 2, lng: (minLon + maxLon) / 2 },
      zoom: 5,
      disableDefaultUI: true,
      gestureHandling: 'none',
      clickableIcons: false,
      styles: [
        { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
        { featureType: 'transit.station.bus', stylers: [{ visibility: 'off' }] },
      ],
    });
    function makeOverlay(t) {
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
        div.appendChild(inner);
        this.getPanes().overlayMouseTarget.appendChild(div);
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
      overlay.setMap(map);
    }
    trucks.forEach(makeOverlay);
    if (trucks.length > 1) {
      const bounds = new google.maps.LatLngBounds();
      trucks.forEach(t => bounds.extend({ lat: t.lat, lng: t.lon }));
      map.fitBounds(bounds, 60);
    } else {
      map.setZoom(8);
    }
  };
</script>
<script src="https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=initMap&v=quarterly" async defer></script>
</body>
</html>`;
}

export function TrucksMap({ height = 240 }: { height?: number }) {
  const router = useRouter();
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const orgId = organization?.id;

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

  // Only render trucks whose Motive vehicle id is wired to an asset in this org.
  const trucks: TruckPin[] = useMemo(
    () => locations
      .map((l: MotiveLocation): TruckPin | null => {
        const asset = assets.find((a) => a.motiveVehicleId === l.vehicleId);
        if (!asset) return null;
        return {
          vehicleId: l.vehicleId,
          lat:       l.lat,
          lon:       l.lon,
          color:     asset.color ?? "#1a73e8",
        };
      })
      .filter((t): t is TruckPin => t !== null),
    [locations, assets],
  );

  const html = useMemo(
    () => buildHtml(trucks, env.googleMapsKey ?? ""),
    [trucks],
  );

  if (!env.googleMapsKey) {
    return (
      <View style={{ height, backgroundColor: "#fef3c7", borderRadius: 14, alignItems: "center", justifyContent: "center", padding: 16 }}>
        <Text style={[txt(700), { fontSize: 13, color: "#92400e", textAlign: "center" }]}>
          Google Maps key not configured
        </Text>
      </View>
    );
  }

  if (isLoading && locations.length === 0) {
    return (
      <View style={{ height, backgroundColor: "#f1f3f4", borderRadius: 14, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#e8eaed" }}>
        <ActivityIndicator color="#1a73e8" />
      </View>
    );
  }

  return (
    <TouchableOpacity
      activeOpacity={0.95}
      onPress={() => router.push("/map")}
      style={{ height, borderRadius: 14, overflow: "hidden", borderWidth: 1, borderColor: "#e8eaed" }}
    >
      <WebView
        source={{ html }}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        scrollEnabled={false}
        style={{ flex: 1, backgroundColor: "#ffffff" }}
        pointerEvents="none"
      />
      <View pointerEvents="none" style={{
        position: "absolute", top: 10, right: 10,
        backgroundColor: "rgba(0,0,0,0.5)", borderRadius: 8, padding: 6,
      }}>
        <Maximize2 size={14} color="#ffffff" strokeWidth={2.2} />
      </View>
    </TouchableOpacity>
  );
}
