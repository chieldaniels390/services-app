# ProNow – home services on demand

An Uber/Bolt-style marketplace for home services in South Africa: **plumbers, electricians, cleaners, locksmiths, handymen, aircon & heating, painters, appliance repair, pest control and gardeners**. Prices are in rand (ZAR).

Customers get an upfront price and pay by card through **Paystack** when they book. Nearby pros receive the request in real time, the first to accept gets the job, and the customer tracks them live on a map until the work is done and rated.

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
- Pay by card with Paystack at booking. The money is held until the job is done, and cancelling before work starts refunds it in full
- Approve and pay for any parts the pro added (charged to the saved card, or via a new checkout)
- Report a problem (dispute) once the pro has arrived, up to 14 days after the job
- See a **Verified** badge on their pro
- Rate and review afterwards; booking history

**Pros**
- Sign up with the services you offer, then **get verified**: upload an ID, a trade certificate or licence, and a selfie. Only approved pros can go online, receive requests or accept jobs
- Go online/offline
- New requests nearby **pop up instantly** with distance, ETA and your payout (exact address hidden until you accept)
- First pro to accept wins (atomic; others see the job disappear)
- Step through the job, add materials cost on completion, open navigation in Google Maps
- Share live GPS, or use **Demo drive** to simulate driving to the customer
- Release a job you can't make – it goes straight back to other pros
- Add a South African bank account and get paid automatically when a job is marked complete (job price minus the platform fee, plus parts in full)
- Payouts page with transfer status and a retry button for failed transfers
- Earnings for today / 7 days / all time, rating, job history

**Admin panel** (`/admin`)
- **Overview:** what needs attention (pros to verify, open disputes, failed or held payouts) and key numbers
- **Pros:** a verification queue with each pro's ID, certificate and selfie side by side. Approve, reject with a reason the pro sees, or suspend an approved pro
- **Jobs:** search by job number, name, email or address and filter by status. Each job page shows the people, the full money trail (payments, refunds, payouts), disputes and the chat log
- **Disputes:** resolve with an optional refund, then release the pro's held payout or cancel it. Both sides see the outcome note
- **Refunds:** issue partial or full refunds on any paid job, with a reason. They go through Paystack and are recorded with who issued them

**Platform**
- Platform fee (default 15%, set with `PLATFORM_FEE_RATE`) on the upfront price; parts go 100% to the pro. Each job keeps the fee rate it was booked at
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

## Notifications

| In-app bell | Settings | Texts sent, as the admin sees them |
| --- | --- | --- |
| ![](docs/screenshots/notifications.png) | ![](docs/screenshots/notification-settings.png) | ![](docs/screenshots/admin-sms.png) |

Every event goes through one place (`server/src/notifications.js`), which decides the wording and the channels:

| Event | Who | In-app | Push | SMS |
| --- | --- | :-: | :-: | :-: |
| Pro accepted the job | Customer | ✓ | ✓ | ✓ |
| Pro is on the way (with ETA) | Customer | ✓ | ✓ | ✓ |
| Pro has arrived | Customer | ✓ | ✓ | |
| Job complete (total, or parts to approve) | Customer | ✓ | ✓ | ✓ |
| Pro had to drop the job | Customer | ✓ | ✓ | |
| Refund issued | Customer | ✓ | ✓ | |
| New job request nearby | Pro | | ✓ | |
| Customer cancelled | Pro | ✓ | ✓ | |
| Payout paid to bank | Pro | ✓ | ✓ | |
| Verification approved / needs attention | Pro | ✓ | ✓ | |
| New chat message | Other party | | ✓ | |
| Dispute opened / resolved | Both | ✓ | ✓ | |

- **In-app:** a 🔔 bell with an unread count, plus a toast when something arrives while you're on a different page. Notifications are stored, so nothing is lost if you were offline.
- **Push:** standard Web Push through a service worker (`client/public/sw.js`). It works in Chrome, Edge, Firefox and Safari. On iPhone it needs iOS 16.4+ and the app added to the home screen; the Settings page explains this.
  - The worker doesn't show a push while the app is open in front, because the in-app toast covers it.
  - Tapping a notification opens the job.
  - Signing out unlinks the browser, so the next person on that device doesn't get the previous user's alerts.
  - Pushes are only sent to the browser vendors' push services, so a user can't make the server send requests to an internal address.
- **SMS:** only for the three key customer moments. Messages are plain ASCII (so each fits in one SMS) and include a link to the job.
  - Numbers are normalised to international format, so `082 555 1234` becomes `+27825551234`.
  - Customers can turn texts off in Settings.
  - Every SMS attempt is logged and shown on the admin job page, with its status and any error.
- Delivery happens in the background. A slow or failing SMS provider never slows down or breaks the job update itself.

### Choosing an SMS provider

Set `SMS_PROVIDER`:

| Value | What it does | Needs |
| --- | --- | --- |
| `console` (default) | Prints texts to the server log, for development | – |
| `none` | SMS off | – |
| `twilio` | [Twilio](https://www.twilio.com/docs/messaging) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID` |
| `bulksms` | [BulkSMS](https://www.bulksms.com/developer/json/v1/) (South African) | `BULKSMS_TOKEN_ID`, `BULKSMS_TOKEN_SECRET`, optional `SMS_SENDER_ID` |

Switching providers is just a config change. To add another one (Clickatell, Africa's Talking, Infobip...), write a ~25-line adapter with a single `send({ to, body })` method and register it in one line. See [`server/src/sms/README.md`](server/src/sms/README.md). The server refuses to start if the provider name is wrong or its credentials are missing, so a typo can't silently stop SMS.

The Twilio and BulkSMS adapters are tested against the request format in each provider's API docs. Send yourself a test text before relying on them.

### Push keys

Web Push needs a VAPID key pair. If `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` aren't set, the server generates a pair on first start and stores it in the database.
- That's fine for a single server.
- If you run several servers, or might move the database, generate the keys once with `npx web-push generate-vapid-keys` and set them in the environment.
- Changing the keys invalidates every existing subscription; users simply turn notifications on again.
- Set `VAPID_SUBJECT` to a `mailto:` address that push services can contact you on.

## Verification, disputes and admin

| Pro uploads documents | Admin reviews a pro | Admin resolves a dispute |
| --- | --- | --- |
| ![](docs/screenshots/pro-verification.png) | ![](docs/screenshots/admin-verify.png) | ![](docs/screenshots/admin-job.png) |

**Creating your admin account.** There's no sign-up for admins. On the server, run:

```bash
npm run create-admin -- you@example.com "Your Name"
```

It prints a generated password once, or set `ADMIN_PASSWORD` to choose one (12+ characters). Then sign in normally and you land on `/admin`. The demo seed also creates `admin@demo.com`, for local use only. The seed script refuses to run when `NODE_ENV=production`.

**Verification.** A pro moves from *not submitted* → *pending* → *approved* or *rejected*.
- Uploads are checked by their actual contents, not their file name: JPG, PNG, WebP or PDF, and photos only for the selfie. Each file is capped at 8 MB.
- Files are stored under `UPLOAD_DIR` with random names, outside the public web folder. They're served only to the pro who uploaded them and to admins.
- A replaced document deletes the old file.
- Documents are locked while under review and once approved.
- Rejecting an approved pro suspends them: they go offline straight away and stop receiving jobs.

**Disputes.**
- The customer or the assigned pro can raise one once the pro has arrived, up to 14 days after completion. Admins can open one on any job.
- While a dispute is open, any payout not yet sent is held. A payout that was already transferred can't be pulled back. A refund in that case comes out of the platform's balance.
- Resolving a dispute applies the refund first. If Paystack refuses, the dispute stays open and nothing else changes. Then the held payouts are released or cancelled.

**Refunds.** Every refund goes through one code path, whether it's a customer cancellation, an automatic duplicate-payment refund, an admin refund or a dispute refund. The amount is reserved before calling Paystack, so two admins clicking at once can't refund more than was paid.

**Sign-in protection.** After 10 failed attempts for the same email from the same IP address, sign-in is blocked for 15 minutes.

### Before you go live with real IDs

ID documents and selfies are personal information under **POPIA**.
- Put `UPLOAD_DIR` on encrypted storage that's backed up and not publicly reachable. For more than one server, move it to private object storage such as S3, with short-lived signed links.
- Decide how long you keep documents after approval or account closure, and say so in your privacy policy.
- Give admin accounts strong, unique passwords and keep the list of admins short.
- Consider an ID-verification provider for automatic ID and face matching. The review queue stays the same; the provider's result becomes another input for the reviewer.

## Payments (Paystack)

```
Customer books ──► Paystack checkout ──► money held in your Paystack balance
                                              │
        job goes out to pros once paid ◄──────┘
                                              │
Pro marks job complete ──► Paystack transfer to pro's bank: price − platform fee
Customer approves parts ──► saved card charged ──► transfer to pro: parts in full
Customer cancels before work starts ──► full refund
```

- Payment is confirmed with Paystack's API both when the customer returns from checkout and when the `charge.success` webhook arrives. Whichever comes first applies it, and repeats do nothing.
- If a customer manages to pay twice, or pays for a booking they already cancelled, the extra payment is refunded automatically.
- If a pro hasn't added bank details yet, or a transfer fails, the payout is kept. It's sent when they add their account or press **Retry failed** on the Payouts page.

| Customer approves parts | Pro payouts |
| --- | --- |
| ![](docs/screenshots/approve-parts.png) | ![](docs/screenshots/payouts.png) |

### Setting up Paystack (test mode)

1. Create a Paystack account for South Africa and copy your **test secret key** (`sk_test_…`) from *Settings → API Keys & Webhooks*.
2. Run the server with it:
   ```bash
   PAYSTACK_SECRET_KEY=sk_test_xxx APP_URL=http://localhost:5173 npm run dev
   ```
   The header shows a **Test** badge while a test key is in use.
3. Pay with one of [Paystack's test cards](https://paystack.com/docs/payments/test-payments/). No real money moves.
4. **Webhooks:** set the webhook URL to `https://<your-domain>/api/paystack/webhook`. Locally you can skip this, because payments are also confirmed when the customer returns from checkout. Transfer and refund updates do need the webhook, so use a tunnel such as `cloudflared` or `ngrok` to test those.
5. **Payouts:** pros add their bank account on the Payouts page (it creates a Paystack transfer recipient). In the Paystack dashboard:
   - make sure Transfers are enabled for your account;
   - turn off OTP for transfers, otherwise API transfers will fail with a message saying so;
   - transfers are paid from your Paystack balance, so check your settlement settings with Paystack so that collected payments stay available for payouts.

Before going live:
- Switch to your live key (`sk_live_…`).
- Paystack's own fees for card payments and transfers come out of the platform's share, so set `PLATFORM_FEE_RATE` to cover them. See [Paystack pricing](https://paystack.com/za/pricing).

## Tech stack

- **Server:** Node.js 22+, Express 5, Socket.IO, SQLite via Node's built-in `node:sqlite` (no native deps)
- **Client:** React 19, Vite, React Router, Leaflet + OpenStreetMap (no API keys)
- **Tests:** `node:test` API + realtime tests

```
server/src
  app.js         HTTP routes + Socket.IO wiring
  jobs.js        job lifecycle, dispatch, chat, earnings
  pricing.js     quotes, surge, fee split
  paystack.js    Paystack API client + webhook signature check
  payments.js    booking payments, refunds, parts, payouts
  verification.js  pro documents + approval
  disputes.js    raising and resolving disputes
  admin.js       admin panel queries
  notifications.js  every notification's wording + delivery (in-app, push, SMS)
  push.js        Web Push subscriptions and sending
  sms/           SMS provider adapters (console, twilio, bulksms) - add your own here
  create-admin.js  CLI to create an admin account
  geocoder.js    address search / reverse lookup (Nominatim), throttled + cached
  db.js          schema
  seed.js        demo accounts
client/src
  pages/         Landing, Auth, CustomerHome, ProviderHome, JobPage, History, Payouts, Verification
  pages/admin/   Overview, Pros, Pro, Jobs, Job, Disputes (loaded only for admins)
  components/    MapView, AddressSearch, Chat, StatusTimeline, Stars, Bell, PushPrompt, ...
  public/sw.js   service worker for push notifications
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
| admin@demo.com | Admin panel |
| customer@demo.com | Customer |
| plumber@demo.com | Plumbing, Heating & AC |
| electrician@demo.com | Electrical, Appliances |
| cleaner@demo.com | Cleaning |
| locksmith@demo.com | Locksmith, Handyman |
| handyman@demo.com | Handyman, Painting, Gardening |
| newpro@demo.com | Plumbing, Handyman, **waiting for verification** (try approving them as admin) |

**Try the full flow** (needs a Paystack test key, see below): open the app in two browser windows (one normal, one private). Sign in as `customer@demo.com` in one and `plumber@demo.com` in the other. As the pro, add a bank account on the Payouts page. As the customer, request a plumber and pay with a test card. Then accept the job as the pro, then tap *Start driving* → *Demo drive* to watch the van move on the customer's map.

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
| `UPLOAD_DIR` | `uploads` | Where verification documents are stored. Keep private and backed up |
| `TOKEN_SECRET` | dev value | **Set this in production** |
| `CURRENCY` | `ZAR` | ISO code used for display |
| `LOCALE` | `en-ZA` | Number formatting locale |
| `PLATFORM_FEE_RATE` | `0.15` | Platform's share of the upfront price (0.15 = 15%). Applies to new bookings |
| `PAYSTACK_SECRET_KEY` | – | `sk_test_…` for test mode. Booking is disabled until set |
| `APP_URL` | `http://localhost:5173` | Public URL customers return to after checkout |
| `SMS_PROVIDER` | `console` | `console`, `none`, `twilio` or `bulksms` (see Notifications) |
| `SMS_DEFAULT_COUNTRY_CODE` | `27` | Used to turn local numbers like `082…` into `+27…` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | generated | Web Push keys. Set them if you run more than one server |
| `VAPID_SUBJECT` | `mailto:support@example.com` | Contact address for push services |
| `PAYSTACK_BASE_URL` | `https://api.paystack.co` | Only changed for tests |
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

- Cancellation fees once a pro is on the way; automatically expire unpaid bookings
- Automatic ID and face matching through a verification provider
- Delivery receipts from the SMS provider, and a notification history clean-up job
- Admin actions for failed payouts (retry or mark as paid by hand), and an audit log of admin actions
- Pro verification (ID, licences, insurance) and an admin console
- Photo uploads on requests, push notifications / SMS
- Routing-based ETAs (road distance instead of straight line)
- Native apps (React Native) reusing the same API
- Postgres + PostGIS for geo queries at scale
