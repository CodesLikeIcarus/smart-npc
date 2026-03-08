/**
 * TeleportDestination — Types for the RP1 teleport destinations system.
 *
 * Destinations are fetched from CDN and come in two flavors:
 *   - "terrestrial": Uses celestialID + geoPos (lat/lon/radius in radians)
 *   - "object": Uses objectID as the coordinate-frame parent (objectType determines wClass)
 *
 * @see https://cdn.rp1.com/res/misc/demo2-teleport-destinations.json
 */

/** Terrestrial location — positioned on a celestial body via lat/lon/radius. */
export interface TerrestrialLocation {
  type: 'terrestrial';
  celestialID: number;
  /** [lat_radians, lon_radians, radius_meters] */
  geoPos: [number, number, number];
  rotation: [number, number, number, number];
}

/** Object location — positioned at an in-world object (building, venue, etc.). */
export interface ObjectLocation {
  type: 'object';
  fabricID?: string;
  objectID: number;
  /** "terrestrial" → wClass 72, "celestial" → wClass 71, "physical" → wClass 73 */
  objectType: 'terrestrial' | 'celestial' | 'physical';
  rotation: [number, number, number, number];
  scatter?: number;
  /** Optional explicit position offset from object origin */
  position?: [number, number, number];
}

export type DestinationLocation = TerrestrialLocation | ObjectLocation;

/** A named teleport destination as returned by the CDN JSON. */
export interface TeleportDestination {
  name: string;
  location: DestinationLocation;
  pin?: {
    name: string;
    modelScale: number;
    textScale: number;
    rotation: [number, number, number, number];
    minSurfaceDist: number;
    minMidSurfaceDist: number;
    midMaxSurfaceDist: number;
    maxSurfaceDist: number;
  };
}

/** CDN URL for the teleport destinations manifest. */
export const DESTINATIONS_CDN_URL = 'https://cdn.rp1.com/res/misc/demo2-teleport-destinations.json';

/** MV MapModelType class constants used in UPDATE payloads (from MVRP_Map.js). */
export const MapModelClass = {
  Root: 70,
  Celestial: 71,
  Terrestrial: 72,
  Physical: 73,
} as const;

/**
 * Fetch all teleport destinations from the RP1 CDN.
 * Caches the result for subsequent calls.
 */
let _cachedDestinations: TeleportDestination[] | null = null;

export async function fetchDestinations(): Promise<TeleportDestination[]> {
  if (_cachedDestinations) return _cachedDestinations;

  const response = await fetch(DESTINATIONS_CDN_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch destinations: ${response.status} ${response.statusText}`);
  }

  _cachedDestinations = (await response.json()) as TeleportDestination[];
  console.log(`[TeleportDestination] Loaded ${_cachedDestinations.length} destinations from CDN`);
  return _cachedDestinations;
}

/**
 * Convert geoPos [lat_rad, lon_rad, radius_m] to Cartesian [x, y, z] (Y-up).
 * Note: The CDN geoPos values are already in radians, unlike the UI inputs which are in degrees.
 */
export function geoPosToCartesian(geoPos: [number, number, number]): { x: number; y: number; z: number } {
  const [latRad, lonRad, radius] = geoPos;

  const cosLat = Math.cos(latRad);
  const x = radius * cosLat * Math.sin(lonRad);
  const y = radius * Math.sin(latRad);
  const z = radius * cosLat * Math.cos(lonRad);

  return { x, y, z };
}
