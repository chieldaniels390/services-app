import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from './errors.js';

/** Raised when Paystack answers but refuses the request (bad account number, insufficient balance...). */
export class PaystackError extends HttpError {
  constructor(message, httpStatus) {
    super(httpStatus >= 500 ? 502 : 400, message);
    this.definitive = true;
  }
}

/**
 * Thin client for the Paystack REST API. Amounts are in the currency's subunit (cents for ZAR).
 * https://paystack.com/docs/api/
 */
export function createPaystack({ secretKey, baseUrl = 'https://api.paystack.co', currency = 'ZAR' }) {
  async function call(method, path, body) {
    if (!secretKey) throw new HttpError(503, 'Payments are not set up yet - add PAYSTACK_SECRET_KEY on the server');
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${secretKey}`, ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    }).catch(() => null);
    if (!res) throw new HttpError(502, 'Could not reach Paystack - please try again');
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.status === false) throw new PaystackError(json.message ?? `Paystack error (${res.status})`, res.status);
    return json.data;
  }

  return {
    configured: Boolean(secretKey),
    testMode: Boolean(secretKey?.startsWith('sk_test_')),

    initialize: ({ email, amountCents, reference, callbackUrl, metadata }) =>
      call('POST', '/transaction/initialize', { email, amount: amountCents, currency, reference, callback_url: callbackUrl, metadata }),
    verify: (reference) => call('GET', `/transaction/verify/${encodeURIComponent(reference)}`),
    chargeAuthorization: ({ email, amountCents, authorizationCode, reference, metadata }) =>
      call('POST', '/transaction/charge_authorization', { email, amount: amountCents, currency, authorization_code: authorizationCode, reference, metadata }),
    refund: (reference) => call('POST', '/refund', { transaction: reference }),

    listBanks: () => call('GET', `/bank?country=${encodeURIComponent('south africa')}&currency=${currency}&perPage=100`),
    // 'basa' is Paystack's recipient type for South African bank accounts.
    createRecipient: ({ name, accountNumber, bankCode }) =>
      call('POST', '/transferrecipient', { type: 'basa', name, account_number: accountNumber, bank_code: bankCode, currency }),
    transfer: ({ amountCents, recipient, reference, reason }) =>
      call('POST', '/transfer', { source: 'balance', amount: amountCents, recipient, reference, reason, currency }),

    /** Webhooks are signed with HMAC-SHA512 of the raw body using the secret key. */
    isValidSignature(rawBody, signature) {
      if (!secretKey || typeof signature !== 'string') return false;
      const expected = Buffer.from(createHmac('sha512', secretKey).update(rawBody).digest('hex'));
      const actual = Buffer.from(signature);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    },
  };
}
