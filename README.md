# ProNow – home services on demand

An Uber/Bolt-style marketplace for home services in South Africa: **plumbers, electricians, cleaners, locksmiths, handymen, aircon & heating, painters, appliance repair, pest control and gardeners**. Prices are in rand (ZAR).

Customers get an upfront price, nearby pros receive the request in real time, the first to accept gets the job, and the customer tracks them live on a map until the work is done and rated.

| Address search & upfront quote | Live tracking + chat | Pro dashboard |
| --- | --- | --- |
| ![](docs/screenshots/request.png) | ![](docs/screenshots/tracking.png) | ![](docs/screenshots/pro-dashboard.png) |

> Map tiles and address search use OpenStreetMap and work in a normal browser. They were blocked in the sandbox that took these screenshots, so a stand-in address service was used.

## Features

**Customers**
- Choose a service, **search for an address** (the pin jumps to it), tap the map or use GPS (the address fills in), describe the problem, pick job size and ASAP or a scheduled time
- Upfront price: call-out fee + hourly labour × estimated hours, with **demand-based surge** when requests outnumber available pros
- See how many pros are nearby and their ETA before booking
- Live status (requested → accepted → on the way → arrived → in progress → completed) with the pro's position moving on the map
- In-app chat and click-to-call with the assigned pro
- Cancel before work starts; rate and review afterwards; booking history

**Pros**
- Sign up with the services you offer, go online/offline
- New requests nearby **pop up instantly** with distance, ETA and your payout (exact address hidden until you accept)
- First pro to accept wins (atomic; others see the job disappear)
- Step through the job, add materials cost on completion, open navigation in Google Maps
- Share live GPS, or use **Demo drive** to simulate driving to the customer
- Release a job you can't make – it goes straight back to other pros
- Earnings for today / 7 days / all time, rating, job history

**Platform**
- Platform fee (default 15%) on labour; materials go 100% to the pro
- Busy pros (with an active job) are not offered new work
- Role-based access: pros only see open requests in their categories, nobody else can read a job

## Prices

Typical 2025/26 South African rates, set in `server/src/categories.js` (amounts in cents):

| Service | Call-out | Per hour | Quick fix (1h) |
| --- | ---: | ---: | ---: |
| Plumbing | R450 | R550 | R1 000 |
| Electrical | R500 | R600 | R1 100 |
| Cleaning | R100 | R150 | R250 |
| Locksmith | R550 | R500 | R1 050 |
| Handyman | R300 | R350 | R650 |
| Aircon & Heating | R650 | R700 | R1 350 |
| Painting | R300 | R350 | R650 |
| Appliance Repair | R450 | R500 | R950 |
| Pest Control | R500 | R550 | R1 050 |
| Gardening | R150 | R180 | R330 |

Standard jobs are quoted at 2 hours and big jobs at 4. Rates differ between cities and suburbs, so check them against local competitors before launch.

## Tech stack

- **Server:** Node.js 22+, Express 5, Socket.IO, SQLite via Node's built-in `node:sqlite` (no native deps)
- **Client:** React 19, Vite, React Router, Leaflet + OpenStreetMap (no API keys)
- **Tests:** `node:test` API + realtime tests

```
server/src
  app.js         HTTP routes + Socket.IO wiring
  jobs.js        job lifecycle, dispatch, chat, earnings
  pricing.js     quotes, surge, fee split
  geocoder.js    address search / reverse lookup (Nominatim), throttled + cached
  db.js          schema
  seed.js        demo accounts
client/src
  pages/         Landing, Auth, CustomerHome, ProviderHome, JobPage, History
  components/    MapView, AddressSearch, Chat, StatusTimeline, Stars
```

## Getting started

Requires **Node.js 22.13+**.

```bash
npm install
npm run seed      # demo accounts (password: password123)
npm run dev       # API on :4000, app on http://localhost:5173
```

Demo accounts:

| Email | Role |
| --- | --- |
| customer@demo.com | Customer |
| plumber@demo.com | Plumbing, Heating & AC |
| electrician@demo.com | Electrical, Appliances |
| cleaner@demo.com | Cleaning |
| locksmith@demo.com | Locksmith, Handyman |
| handyman@demo.com | Handyman, Painting, Gardening |

**Try the full flow:** open the app in two browser windows (one normal, one private). Sign in as `customer@demo.com` in one and `plumber@demo.com` in the other. Request a plumber as the customer and accept it as the pro, then tap *Start driving* → *Demo drive* to watch the van move on the customer's map.

### Production

```bash
npm run build     # builds the client into client/dist
npm start         # serves API + app on PORT (default 4000)
```

### Configuration

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `4000` | |
| `DB_FILE` | `services.db` | SQLite file |
| `TOKEN_SECRET` | dev value | **Set this in production** |
| `CURRENCY` | `ZAR` | ISO code used for display |
| `LOCALE` | `en-ZA` | Number formatting locale |
| `PLATFORM_FEE_RATE` | `0.15` | |
| `DISPATCH_RADIUS_KM` | `30` | How far away pros get offered a job |
| `DEFAULT_LAT` / `DEFAULT_LNG` | Johannesburg | Default map centre |
| `GEOCODER_URL` | `https://nominatim.openstreetmap.org` | Any Nominatim-compatible API |
| `GEOCODER_USER_AGENT` | `ProNow/1.0 …` | **Set to your app name + contact email** (Nominatim policy) |
| `GEOCODER_COUNTRIES` | `za` | Limit address search to these countries (comma-separated, empty for all) |

Address lookups go through the server, which caches results and keeps to Nominatim's free-tier limit of one request per second. That's enough for testing and a small launch. For real traffic, self-host Nominatim or use a paid provider with a compatible API, and point `GEOCODER_URL` at it.

Service categories and prices live in `server/src/categories.js`.

### Tests

```bash
npm test
```

## Roadmap

- Payments and payouts (e.g. Stripe Connect), cancellation fees
- Pro verification (ID, licences, insurance) and an admin console
- Photo uploads on requests, push notifications / SMS
- Routing-based ETAs (road distance instead of straight line)
- Native apps (React Native) reusing the same API
- Postgres + PostGIS for geo queries at scale
