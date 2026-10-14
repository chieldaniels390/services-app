import { createBulkSmsProvider } from './bulksms.js';
import { createConsoleProvider } from './console.js';
import { createTwilioProvider } from './twilio.js';

// To add a provider, write an adapter (see README.md in this folder) and register it here.
const PROVIDERS = {
  none: () => null,
  console: createConsoleProvider,
  twilio: createTwilioProvider,
  bulksms: createBulkSmsProvider,
};

export function settingsFromEnv(env = process.env) {
  return {
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      from: env.TWILIO_FROM,
      messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
    },
    bulksms: { tokenId: env.BULKSMS_TOKEN_ID, tokenSecret: env.BULKSMS_TOKEN_SECRET, from: env.SMS_SENDER_ID },
    console: {},
    none: {},
  };
}

/** Returns the configured provider, or null when SMS is switched off. Fails fast on a typo or missing credentials. */
export function createSmsProvider(name = 'console', settings = settingsFromEnv()) {
  const factory = PROVIDERS[name];
  if (!factory) throw new Error(`Unknown SMS_PROVIDER "${name}". Available: ${Object.keys(PROVIDERS).join(', ')}`);
  return factory(settings[name] ?? {});
}
