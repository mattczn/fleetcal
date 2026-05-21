import { setOptions, importLibrary } from '@googlemaps/js-api-loader';

/**
 * Singleton Google Maps JS loader. Caches the load promise so any caller
 * can `await loadGoogleMaps()` without re-triggering script injection.
 */
let loadPromise: Promise<typeof google> | null = null;

const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';

// AdvancedMarkerElement requires a Map ID. DEMO_MAP_ID is fine for development;
// for production set NEXT_PUBLIC_GOOGLE_MAP_ID to a Map ID created in Google Cloud Console.
export const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAP_ID ?? 'DEMO_MAP_ID';

export function loadGoogleMaps(): Promise<typeof google> {
  if (loadPromise) return loadPromise;
  if (!API_KEY) {
    return Promise.reject(new Error('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is not set'));
  }
  setOptions({ key: API_KEY, v: 'weekly' });
  loadPromise = Promise.all([
    importLibrary('maps'),
    importLibrary('marker'),
    importLibrary('routes'),
  ]).then(() => google);
  return loadPromise;
}
