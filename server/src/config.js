function codespaceUrl() {
  const { CODESPACE_NAME: name, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: domain } = process.env;
  return name && domain ? `https://${name}-${process.env.PORT ?? 4000}.${domain}` : null;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  dbFile: process.env.DB_FILE ?? 'services.db',
  // Verification documents (IDs, selfies). Keep this outside any public folder and back it up securely.
  uploadDir: process.env.UPLOAD_DIR ?? 'uploads',
  tokenSecret: process.env.TOKEN_SECRET ?? 'dev-secret-change-me',
  tokenTtlSeconds: 60 * 60 * 24 * 30,
  currency: process.env.CURRENCY ?? 'ZAR',
  locale: process.env.LOCALE ?? 'en-ZA',
  // Share of the upfront (call-out + labour) price kept by the platform; parts go to the pro in full.
  // Each job stores the rate in force when it was booked, so changing this never alters existing jobs.
  platformFeeRate: Number(process.env.PLATFORM_FEE_RATE ?? 0.15),
  // Public URL of the app; Paystack sends customers back here after checkout.
  // In GitHub Codespaces this defaults to the forwarded address of PORT (the built app).
  appUrl: (process.env.APP_URL ?? codespaceUrl() ?? 'http://localhost:5173').replace(/\/$/, ''),
  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY ?? '',
    baseUrl: process.env.PAYSTACK_BASE_URL ?? 'https://api.paystack.co',
  },
  // Service radius for pros who haven't set their own service area (around their live location).
  dispatchRadiusKm: Number(process.env.DISPATCH_RADIUS_KM ?? 30),
  maxServiceRadiusKm: Number(process.env.MAX_SERVICE_RADIUS_KM ?? 100),
  // "Book again": how long the chosen pro has the job to themselves before it goes to everyone.
  preferredWindowMinutes: Number(process.env.PREFERRED_PRO_WINDOW_MINUTES ?? 5),
  preferredWindowScheduledMinutes: Number(process.env.PREFERRED_PRO_WINDOW_SCHEDULED_MINUTES ?? 60),
  // Repeat bookings: each visit is booked (and charged to the saved card) this long before it happens.
  recurringLeadHours: Number(process.env.RECURRING_LEAD_HOURS ?? 48),
  safety: {
    // Shown on the emergency sheet and share pages. South Africa: SAPS 10111; 112 works from any mobile.
    emergencyNumbers: [
      { number: '10111', label: 'Police (SAPS)' },
      { number: '112', label: 'Emergency services from any mobile' },
    ],
    // Optional on-call number that gets an SMS for every emergency alert (e.g. +27821234567).
    alertPhone: process.env.SAFETY_ALERT_PHONE ?? '',
    // The emergency button stays available this long after a job is completed.
    afterJobMinutes: Number(process.env.EMERGENCY_AFTER_JOB_MINUTES ?? 60),
  },
  reviews: {
    windowDays: Number(process.env.REVIEW_WINDOW_DAYS ?? 14),
    // Admins see a flag on anyone averaging below this, once they have at least minReviews reviews.
    flagBelow: Number(process.env.LOW_RATING_THRESHOLD ?? 3.5),
    minReviews: Number(process.env.LOW_RATING_MIN_REVIEWS ?? 3),
  },
  // Working hours and "today / this week / this month" earnings use this time zone.
  timezone: process.env.TIMEZONE ?? 'Africa/Johannesburg',
  defaultCenter: {
    lat: Number(process.env.DEFAULT_LAT ?? -26.2041),
    lng: Number(process.env.DEFAULT_LNG ?? 28.0473),
  },
  sms: {
    // console (prints, the default), none, twilio or bulksms. See src/sms/README.md to add another.
    provider: process.env.SMS_PROVIDER ?? 'console',
    defaultCountryCode: process.env.SMS_DEFAULT_COUNTRY_CODE ?? '27',
  },
  push: {
    // Generate with: npx web-push generate-vapid-keys. If unset, keys are generated once and kept in the database.
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT ?? 'mailto:support@example.com',
  },
  // Map tiles. Defaults to CARTO's free "Dark Matter" basemap (OpenStreetMap data), which allows use from any
  // host. The tile servers at tile.openstreetmap.org block apps like this one (403 "Access blocked").
  // Any XYZ tile URL works; {s} picks a subdomain, {r} becomes "@2x" on high-DPI screens.
  map: {
    tileUrl: process.env.MAP_TILE_URL ?? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    subdomains: process.env.MAP_TILE_SUBDOMAINS ?? 'abcd',
    attribution: process.env.MAP_TILE_ATTRIBUTION
      ?? '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: Number(process.env.MAP_TILE_MAX_ZOOM ?? 20),
    // Styles the map background and attribution to suit dark tiles; set to false for a light basemap.
    dark: (process.env.MAP_TILES_DARK ?? 'true') !== 'false',
  },
  geocoder: {
    // Nominatim (OpenStreetMap). Its usage policy needs an identifying User-Agent and at most 1 request/second;
    // for heavy traffic, self-host Nominatim or point this at a commercial provider with a compatible API.
    url: process.env.GEOCODER_URL ?? 'https://nominatim.openstreetmap.org',
    userAgent: process.env.GEOCODER_USER_AGENT ?? 'ProNow/1.0 (home services marketplace)',
    countryCodes: process.env.GEOCODER_COUNTRIES ?? 'za',
  },
};
