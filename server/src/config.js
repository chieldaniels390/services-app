export const config = {
  port: Number(process.env.PORT ?? 4000),
  dbFile: process.env.DB_FILE ?? 'services.db',
  tokenSecret: process.env.TOKEN_SECRET ?? 'dev-secret-change-me',
  tokenTtlSeconds: 60 * 60 * 24 * 30,
  currency: process.env.CURRENCY ?? 'USD',
  // Share of the labour/callout price kept by the platform; materials pass through untouched.
  platformFeeRate: Number(process.env.PLATFORM_FEE_RATE ?? 0.15),
  // Online pros within this radius of a job are offered it.
  dispatchRadiusKm: Number(process.env.DISPATCH_RADIUS_KM ?? 30),
  defaultCenter: {
    lat: Number(process.env.DEFAULT_LAT ?? 51.5074),
    lng: Number(process.env.DEFAULT_LNG ?? -0.1278),
  },
};
