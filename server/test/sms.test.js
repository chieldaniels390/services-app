import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { toE164 } from '../src/phone.js';
import { createSmsProvider } from '../src/sms/index.js';
import { createBulkSmsProvider } from '../src/sms/bulksms.js';
import { createTwilioProvider } from '../src/sms/twilio.js';

// Records what each adapter sends, standing in for the providers' APIs.
let server;
let url;
const received = [];
let reply = { status: 201, body: {} };

before(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    received.push({ method: req.method, path: req.url, headers: req.headers, raw });
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise((r) => server.listen(0, r));
  url = `http://localhost:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

test('South African numbers normalise to E.164', () => {
  assert.equal(toE164('082 555 1234'), '+27825551234');
  assert.equal(toE164('+27 82 555 1234'), '+27825551234');
  assert.equal(toE164('27825551234'), '+27825551234');
  assert.equal(toE164('0027825551234'), '+27825551234');
  assert.equal(toE164('(082) 555-1234'), '+27825551234');
  assert.equal(toE164('+44 7700 900123'), '+447700900123');
  assert.equal(toE164('12345'), null);
  assert.equal(toE164(''), null);
  assert.equal(toE164(null), null);
});

test('Twilio adapter', async () => {
  reply = { status: 201, body: { sid: 'SM123' } };
  const sms = createTwilioProvider({ accountSid: 'AC1', authToken: 'secret', from: '+15005550006', baseUrl: url });
  assert.deepEqual(await sms.send({ to: '+27825551234', body: 'Hello' }), { id: 'SM123' });
  const req = received.at(-1);
  assert.equal(req.path, '/2010-04-01/Accounts/AC1/Messages.json');
  assert.equal(req.headers.authorization, `Basic ${Buffer.from('AC1:secret').toString('base64')}`);
  assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(req.raw)), { To: '+27825551234', Body: 'Hello', From: '+15005550006' });

  reply = { status: 400, body: { message: "The 'To' number is not a valid phone number." } };
  await assert.rejects(sms.send({ to: '+27', body: 'x' }), /not a valid phone number/);
});

test('BulkSMS adapter', async () => {
  reply = { status: 201, body: [{ id: '4242', type: 'SENT' }] };
  const sms = createBulkSmsProvider({ tokenId: 'tid', tokenSecret: 'tsecret', baseUrl: url });
  assert.deepEqual(await sms.send({ to: '+27825551234', body: 'Hello' }), { id: '4242' });
  const req = received.at(-1);
  assert.equal(req.path, '/v1/messages');
  assert.equal(req.headers.authorization, `Basic ${Buffer.from('tid:tsecret').toString('base64')}`);
  assert.deepEqual(JSON.parse(req.raw), { to: '+27825551234', body: 'Hello' });

  reply = { status: 403, body: { title: 'Forbidden', detail: 'Insufficient credits' } };
  await assert.rejects(sms.send({ to: '+27825551234', body: 'x' }), /Insufficient credits/);
});

test('providers are chosen by name and check their settings up front', () => {
  assert.equal(createSmsProvider('none'), null);
  assert.equal(createSmsProvider('console', {}).name, 'console');
  assert.throws(() => createSmsProvider('carrier-pigeon', {}), /Unknown SMS_PROVIDER "carrier-pigeon"/);
  assert.throws(() => createSmsProvider('twilio', { twilio: {} }), /TWILIO_ACCOUNT_SID/);
  assert.throws(() => createSmsProvider('bulksms', { bulksms: {} }), /BULKSMS_TOKEN_ID/);
});
