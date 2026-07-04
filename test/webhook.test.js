// Focused test for Feature 3: Stripe webhook → auto-confirm booking.
// Mocks the 'stripe' module so we can drive checkout.session.completed without network.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.STRIPE_KEY = 'sk_test_fake';          // makes server wire up stripe + webhook
// no STRIPE_WEBHOOK_SECRET -> dev fallback parses raw body (no signature check)

const Module = require('module');
const origRequire = Module.prototype.require;
// Mock stripe before server.js requires it
Module.prototype.require = function (id) {
  if (id === 'stripe') {
    return () => ({
      checkout: { sessions: { create: async () => ({ url: 'https://stripe.test/pay' }) } },
      webhooks: { constructEvent: () => { throw new Error('should not be called without secret'); } },
    });
  }
  return origRequire.apply(this, arguments);
};

const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');
global.fetch = async () => ({ json: async () => [{ lat: '44.78', lon: '20.44' }] });

const { app, mongoose, models } = require('../server');

function req(method, path, { token, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw ? raw : (body ? JSON.stringify(body) : null);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const u = new URL(base + path);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, res => {
      let c = ''; res.on('data', d => c += d);
      res.on('end', () => { let p; try { p = JSON.parse(c); } catch { p = c; } resolve({ status: res.statusCode, body: p }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

let base, server, mongod, passed = 0, failed = 0;
const check = (n, c, e) => c ? (passed++, console.log(`  ✅ ${n}`)) : (failed++, console.log(`  ❌ ${n}  → ${JSON.stringify(e)}`));

(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  server = app.listen(0); await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  try {
    console.log('\n── F3 Stripe webhook auto-confirm ──');
    let r = await req('POST', '/api/register', { body: { email: 'h@t.com', password: 'secret1' } });
    const hostTok = r.body.token;
    r = await req('GET', '/api/me', { token: hostTok }); const hostId = r.body._id;
    r = await req('POST', '/api/register', { body: { email: 'g@t.com', password: 'secret1' } });
    const guestTok = r.body.token;
    r = await req('GET', '/api/me', { token: guestTok }); const guestId = r.body._id;

    r = await req('POST', '/api/listings', { token: hostTok, body: { title: 'Loft', city: 'Belgrade', price: 100, maxGuests: 4 } });
    const lid = r.body.listing._id;

    // create-checkout-session should now work (stripe mocked)
    r = await req('POST', '/api/create-checkout-session', { token: guestTok, body: { listingId: lid, checkIn: '2030-03-01', checkOut: '2030-03-04', guests: 2 } });
    check('create-checkout-session returns url', r.status === 200 && r.body.url, r.body);

    // No booking should exist yet (booking only created on webhook)
    let count = await models.Booking.countDocuments({});
    check('no booking before webhook', count === 0, count);

    // Fire the webhook event
    const evt = { type: 'checkout.session.completed', data: { object: {
      metadata: { listingId: lid, userId: guestId, checkIn: '2030-03-01', checkOut: '2030-03-04', guests: '2' },
    } } };
    r = await req('POST', '/api/stripe/webhook', { raw: JSON.stringify(evt) });
    check('webhook accepted', r.status === 200 && r.body.received, r.body);

    const booking = await models.Booking.findOne({ listingId: lid });
    check('booking auto-created', !!booking, booking);
    check('booking is confirmed', booking && booking.status === 'confirmed', booking?.status);
    check('booking marked paid', booking && booking.paid === true, booking?.paid);
    check('booking has correct guests/nights', booking && booking.guests === 2 && booking.nights === 3, { g: booking?.guests, n: booking?.nights });

    // Fire same webhook again -> must NOT duplicate
    r = await req('POST', '/api/stripe/webhook', { raw: JSON.stringify(evt) });
    count = await models.Booking.countDocuments({ listingId: lid });
    check('webhook is idempotent (no duplicate)', count === 1, count);

  } catch (e) { console.error('CRASH', e); failed++; }
  finally {
    console.log(`\n  PASSED: ${passed}  FAILED: ${failed}`);
    await mongoose.disconnect(); await mongod.stop(); server.close();
    Module.prototype.require = origRequire;
    process.exit(failed ? 1 : 0);
  }
})();
