export const config = {
  port: Number(process.env.PORT ?? 4000),
  dbFile: process.env.DB_FILE ?? 'services.db',
  tokenSecret: process.env.TOKEN_SECRET ?? 'dev-secret-change-me',
  tokenTtlSeconds: 60 * 60 * 24 * 30,
  currency: process.env.CURRENCY ?? 'ZAR',
  locale: process.env.LOCALE ?? 'en-ZA',
  // Share of the labour/callout price kept by the platform; materials pass through untouched.
  platformFeeRate: Number(process.env.PLATFORM_FEE_RATE ?? 0.15),
  // Online pros within this radius of a job are offered it.
  dispatchRadiusKm: Number(process.env.DISPATCH_RADIUS_KM ?? 30),
  defaultCenter: {
    lat: Number(process.env.DEFAULT_LAT ?? -26.2041),
    lng: Number(process.env.DEFAULT_LNG ?? 28.0473),
  },
  geocoder: {
    // Nominatim (OpenStreetMap). Its usage policy needs an identifying User-Agent and at most 1 request/second;
    // for heavy traffic, self-host Nominatim or point this at a commercial provider with a compatible API.
    url: process.env.GEOCODER_URL ?? 'https://nominatim.openstreetmap.org',
    userAgent: process.env.GEOCODER_USER_AGENT ?? 'ProNow/1.0 (home services marketplace)',
    countryCodes: process.env.GEOCODER_COUNTRIES ?? 'za',
  },
};
