/** Twilio Programmable Messaging. https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource */
export function createTwilioProvider({ accountSid, authToken, from, messagingServiceSid, baseUrl = 'https://api.twilio.com' }) {
  if (!accountSid || !authToken || !(from || messagingServiceSid)) {
    throw new Error('Twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM (or TWILIO_MESSAGING_SERVICE_SID)');
  }
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  return {
    name: 'twilio',
    async send({ to, body }) {
      const form = new URLSearchParams({ To: to, Body: body, ...(messagingServiceSid ? { MessagingServiceSid: messagingServiceSid } : { From: from }) });
      const res = await fetch(`${baseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
        method: 'POST',
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Twilio: ${data.message ?? res.status}`);
      return { id: data.sid };
    },
  };
}
