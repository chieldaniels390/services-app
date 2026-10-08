export const config = {
  port: Number(process.env.PORT ?? 4000),
  dbFile: process.env.DB_FILE ?? 'services.db',
  tokenSecret: process.env.TOKEN_SECRET ?? 'dev-secret-change-me',
  tokenTtlSeconds: 60 * 60 * 24 * 30,
  currency: process.env.CURRENCY ?? 'ZAR',
  locale: process.env.LOCALE ?? 'en-ZA',
  // Share of the upfront (call-out + labour) price kept by the platform; parts go to the pro in full.
  // Each job stores the rate in force when it was booked, so changing this never alters existing jobs.
  platformFeeRate: Number(process.env.PLATFORM_FEE_RATE ?? 0.15),
  // Public URL of the app; Paystack sends customers back here after checkout.
  appUrl: (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY ?? '',
    baseUrl: process.env.PAYSTACK_BASE_URL ?? 'https://api.paystack.co',
  },
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
