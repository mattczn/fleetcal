import type { Asset, CalendarEvent, Stop } from './types';

export interface AssetMatch {
  asset: Asset;
  score: number;           // 0–100, higher = better fit
  hasConflict: boolean;
  inboundMiles: number | null;   // deadhead: prev delivery → load pickup
  outboundMiles: number | null;  // deadhead: load delivery → next pickup
  gapMinutesBefore: number | null;
  gapMinutesAfter: number | null;
  prevEvent: CalendarEvent | null;
  nextEvent: CalendarEvent | null;
  reasons: string[];
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Absolute minutes since Unix epoch (date-aware, no timezone conversion needed for naive datetimes)
function isoToMinutes(iso: string): number {
  const [date, time] = iso.split('T');
  if (!date) return 0;
  const [y, mo, d] = date.split('-').map(Number);
  const [h = 0, m = 0] = (time ?? '').split(':').map(Number);
  return new Date(y, mo - 1, d, h, m).getTime() / 60_000;
}

function pickupCoords(event: CalendarEvent): { lat: number; lng: number } | null {
  const stops = event.stops ?? [];
  const pickup = stops.find(s => s.type === 'pickup') ?? stops[0];
  if (pickup?.lat != null && pickup?.lng != null) return { lat: pickup.lat, lng: pickup.lng };
  return null;
}

function deliveryCoords(event: CalendarEvent): { lat: number; lng: number } | null {
  const stops = event.stops ?? [];
  const delivery = [...stops].reverse().find(s => s.type === 'delivery') ?? stops[stops.length - 1];
  if (delivery?.lat != null && delivery?.lng != null) return { lat: delivery.lat, lng: delivery.lng };
  return null;
}

function cityLabel(event: CalendarEvent, side: 'pickup' | 'delivery'): string | null {
  const stops = event.stops ?? [];
  const s = side === 'pickup'
    ? (stops.find(st => st.type === 'pickup') ?? stops[0])
    : ([...stops].reverse().find(st => st.type === 'delivery') ?? stops[stops.length - 1]);
  return s?.city?.trim() || null;
}

export function scoreAssetsForLoad(
  load: CalendarEvent,
  allAssets: Asset[],
  allEvents: CalendarEvent[],
  unassignedAssetId: number | null,
): AssetMatch[] {
  const loadStart = isoToMinutes(load.start);
  const loadEnd   = isoToMinutes(load.end);
  const loadPickup   = pickupCoords(load);
  const loadDelivery = deliveryCoords(load);
  const loadDate = load.start.split('T')[0];

  const results: AssetMatch[] = [];

  for (const asset of allAssets) {
    if (asset.hidden) continue;
    if (asset.id === unassignedAssetId) continue;

    const assetEvents = allEvents
      .filter(e => e.assetId === asset.id && e.assetId !== unassignedAssetId)
      .sort((a, b) => a.start.localeCompare(b.start));

    // Check for time conflicts
    const hasConflict = assetEvents.some(e => {
      const eStart = isoToMinutes(e.start);
      const eEnd   = isoToMinutes(e.end);
      return eStart < loadEnd - 1 && eEnd > loadStart + 1;
    });

    // Find the event immediately before and after the load slot
    const prevEvent = assetEvents
      .filter(e => isoToMinutes(e.end) <= loadStart + 5)
      .sort((a, b) => b.end.localeCompare(a.end))[0] ?? null;
    const nextEvent = assetEvents
      .filter(e => isoToMinutes(e.start) >= loadEnd - 5)
      .sort((a, b) => a.start.localeCompare(b.start))[0] ?? null;

    const gapMinutesBefore = prevEvent ? loadStart - isoToMinutes(prevEvent.end) : null;
    const gapMinutesAfter  = nextEvent ? isoToMinutes(nextEvent.start) - loadEnd : null;

    // Deadhead distance calculations
    let inboundMiles: number | null = null;
    let outboundMiles: number | null = null;

    if (prevEvent && loadPickup) {
      const prevDelivery = deliveryCoords(prevEvent);
      if (prevDelivery) inboundMiles = Math.round(haversine(prevDelivery.lat, prevDelivery.lng, loadPickup.lat, loadPickup.lng));
    }
    if (nextEvent && loadDelivery) {
      const nextPickup = pickupCoords(nextEvent);
      if (nextPickup) outboundMiles = Math.round(haversine(loadDelivery.lat, loadDelivery.lng, nextPickup.lat, nextPickup.lng));
    }

    // --- Scoring ---
    // Primary: is the schedule open today?
    // Secondary: how close is the asset to the pickup location?
    const reasons: string[] = [];

    const todayEvents = assetEvents.filter(e =>
      e.start.split('T')[0] === loadDate || e.end.split('T')[0] === loadDate,
    );

    // Base score from schedule openness
    let score: number;
    if (hasConflict) {
      score = 25;
      reasons.push('Overlaps with an existing load');
    } else if (todayEvents.length === 0) {
      score = 100;
      reasons.push('Open schedule today');
    } else {
      score = 70;
      reasons.push('Available — has other loads today');
    }

    // Proximity penalty: straight-line miles from last delivery to this pickup
    if (inboundMiles !== null) {
      // Penalty ramps from 0 at 0mi to −40 at 200mi, then caps
      const penalty = Math.min(40, Math.round(inboundMiles / 5));
      score = Math.max(1, score - penalty);
      reasons.push(`~${inboundMiles}mi from last delivery to pickup`);
    } else if (prevEvent) {
      // No GPS coords — fall back to city name
      const prevCity = cityLabel(prevEvent, 'delivery');
      const loadCity = cityLabel(load, 'pickup');
      if (prevCity && loadCity) {
        if (prevCity.toLowerCase() === loadCity.toLowerCase()) {
          score = Math.min(100, score + 5);
          reasons.push('Last delivery in same city as pickup');
        } else {
          reasons.push('Location unknown — no GPS on stops');
        }
      }
    }

    score = Math.max(1, Math.min(100, score));

    results.push({ asset, score, hasConflict, inboundMiles, outboundMiles, gapMinutesBefore, gapMinutesAfter, prevEvent, nextEvent, reasons });
  }

  // Sort by score descending (open-schedule assets naturally score higher)
  return results.sort((a, b) => b.score - a.score);
}
