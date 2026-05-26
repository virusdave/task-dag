/**
 * Barrel re-export for the shared address / geocoding helpers used
 * by the sweed-address-enrichment epic (#25). Producers and the
 * geocoder-drain tick should import from this module path rather
 * than reaching into the individual files.
 */

export {
  normaliseAddressParts,
  type NormalizedAddressParts,
  type RawAddressInput,
} from './addressParts.js'

export {
  upsertAddress,
  queueGeocodePending,
  applyGeocodeResult,
  type GeocodeResult,
  type GeocodeStatus,
  type PendingGeocodeAddress,
  type UpsertAddressResult,
} from './addressesQueries.js'

export {
  geocodeViaCensus,
  parseCensusResponse,
  looksDefinitelyNonUS,
  resetCensusRateLimiterForTest,
  type CensusGeocodeResult,
  type CensusGeocodeStatus,
  type GeocodeViaCensusOptions,
} from './census.js'
