/** BulkSMS.com JSON REST API (popular in South Africa). https://www.bulksms.com/developer/json/v1/ */
export function createBulkSmsProvider({ tokenId, tokenSecret, from, baseUrl = 'https://api.bulksms.com' }) {
  if (!tokenId || !tokenSecret) throw new Error('BulkSMS needs BULKSMS_TOKEN_ID and BULKSMS_TOKEN_SECRET');
  const auth = Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64');
  return {
    name: 'bulksms',
    async send({ to, body }) {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
        // A custom sender ID ("from") must be registered with BulkSMS first; without it a shared number is used.
        body: JSON.stringify({ to, body, ...(from && { from }) }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`BulkSMS: ${data.detail ?? data.title ?? res.status}`);
      return { id: Array.isArray(data) ? data[0]?.id : data.id };
    },
  };
}
