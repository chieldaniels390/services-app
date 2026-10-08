import { createServer } from 'node:http';

/**
 * In-memory stand-in for the Paystack API, covering the endpoints the app uses.
 * GET /checkout/:reference plays the customer paying on Paystack's hosted page.
 */
export async function startFakePaystack({ secretKey }) {
  const state = {
    transactions: new Map(),
    refunds: [],
    transfers: [],
    recipients: [],
    transferStatus: 'pending',
    savedCardStatus: 'success',
  };
  let seq = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const ok = (data) => send(200, { status: true, message: 'ok', data });
    const fail = (status, message) => send(status, { status: false, message });

    if (url.pathname.startsWith('/checkout/')) {
      const tx = state.transactions.get(decodeURIComponent(url.pathname.slice('/checkout/'.length)));
      if (!tx) return fail(404, 'Unknown transaction');
      tx.status = 'success';
      res.writeHead(302, { location: `${tx.callback_url}?trxref=${tx.reference}&reference=${tx.reference}` });
      return res.end();
    }
    if (req.headers.authorization !== `Bearer ${secretKey}`) return fail(401, 'Invalid key');

    if (req.method === 'POST' && url.pathname === '/transaction/initialize') {
      if (state.transactions.has(body.reference)) return fail(400, 'Duplicate Transaction Reference');
      const tx = { ...body, status: 'abandoned' };
      state.transactions.set(body.reference, tx);
      return ok({ authorization_url: `${state.url}/checkout/${body.reference}`, access_code: `ac_${++seq}`, reference: body.reference });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/transaction/verify/')) {
      const tx = state.transactions.get(decodeURIComponent(url.pathname.split('/').pop()));
      if (!tx) return fail(404, 'Transaction reference not found');
      return ok({
        status: tx.status, reference: tx.reference, amount: tx.amount, currency: tx.currency,
        authorization: { authorization_code: 'AUTH_saved', reusable: true },
      });
    }
    if (req.method === 'POST' && url.pathname === '/transaction/charge_authorization') {
      state.transactions.set(body.reference, { ...body, status: state.savedCardStatus });
      return ok({ status: state.savedCardStatus, reference: body.reference, amount: body.amount, currency: body.currency });
    }
    if (req.method === 'POST' && url.pathname === '/refund') {
      if (state.refunds.includes(body.transaction)) return fail(400, 'Transaction has been fully reversed');
      state.refunds.push(body.transaction);
      return ok({ status: 'pending', transaction: { reference: body.transaction } });
    }
    if (req.method === 'GET' && url.pathname === '/bank') {
      return ok([
        { name: 'Capitec Bank', code: '470010', active: true },
        { name: 'First National Bank', code: '250655', active: true },
      ]);
    }
    if (req.method === 'POST' && url.pathname === '/transferrecipient') {
      state.recipients.push(body);
      return ok({ recipient_code: `RCP_${++seq}`, details: { account_number: body.account_number, bank_code: body.bank_code } });
    }
    if (req.method === 'POST' && url.pathname === '/transfer') {
      if (state.transfers.some((t) => t.reference === body.reference)) return fail(400, 'Duplicate Transfer Reference');
      if (state.transferStatus === 'error') return fail(400, 'Your balance is not enough to fulfil this request');
      state.transfers.push(body);
      return ok({ status: state.transferStatus, reference: body.reference, transfer_code: `TRF_${++seq}`, amount: body.amount });
    }
    fail(404, `No fake for ${req.method} ${url.pathname}`);
  });

  await new Promise((r) => server.listen(0, r));
  state.url = `http://localhost:${server.address().port}`;
  return {
    state,
    url: state.url,
    /** Simulates the customer completing checkout without following the redirect. */
    pay: (reference) => { state.transactions.get(reference).status = 'success'; },
    close: () => new Promise((r) => server.close(r)),
  };
}
