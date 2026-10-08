import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGeocoder } from '../src/geocoder.js';

// A stand-in for Nominatim that records what it was asked.
const requests = [];
let server;
let url;

before(async () => {
  server = createServer((req, res) => {
    requests.push({ url: new URL(req.url, 'http://x'), userAgent: req.headers['user-agent'] });
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/search')) {
      res.end(JSON.stringify([{
        lat: '-33.9180', lon: '18.4233', name: '',
        display_name: '12, Long Street, Cape Town City Centre, Cape Town, Western Cape, 8001, South Africa',
        address: { house_number: '12', road: 'Long Street', suburb: 'Cape Town City Centre', city: 'Cape Town' },
      }]));
    } else if (req.url.includes('lat=0')) {
      res.end(JSON.stringify({ error: 'Unable to geocode' }));
    } else {
      res.end(JSON.stringify({ name: 'Sandton City', address: { road: 'Rivonia Road', suburb: 'Sandhurst', city: 'Johannesburg' } }));
    }
  });
  await new Promise((r) => server.listen(0, r));
  url = `http://localhost:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('search returns short labels, restricts country and identifies itself', async () => {
  const geo = createGeocoder({ url, userAgent: 'ProNow-test', countryCodes: 'za' });
  const results = await geo.search('12 Long Street');
  assert.deepEqual(results, [{ label: '12 Long Street, Cape Town City Centre, Cape Town', lat: -33.918, lng: 18.4233 }]);
  const sent = requests.at(-1);
  assert.equal(sent.url.searchParams.get('countrycodes'), 'za');
  assert.equal(sent.userAgent, 'ProNow-test');

  // Repeat queries are served from cache.
  const before = requests.length;
  await geo.search('12 Long Street');
  assert.equal(requests.length, before);
});

test('reverse lookup names the place, or returns null when nothing is there', async () => {
  const geo = createGeocoder({ url, userAgent: 'ProNow-test', countryCodes: 'za' });
  assert.deepEqual(await geo.reverse(-26.108, 28.053), { label: 'Sandton City, Rivonia Road, Sandhurst, Johannesburg', lat: -26.108, lng: 28.053 });
  assert.equal(await geo.reverse(0, 0), null);
});

test('upstream failures become a friendly 502', async () => {
  const geo = createGeocoder({ url: 'http://localhost:1', userAgent: 'x' });
  await assert.rejects(geo.search('anything'), { status: 502 });
});
