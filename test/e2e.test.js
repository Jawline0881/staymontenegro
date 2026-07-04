// e2e smoke test — boots the Express app against an in-memory MongoDB and
// exercises every feature end-to-end via supertest-style raw http.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';

const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Stub geocoding network call (nominatim) so tests are offline + fast
global.fetch = async (url) => ({
  json: async () => {
    if (String(url).includes('nominatim')) return [{ lat: '42.4304', lon: '18.7712' }];
    return [];
  },
});

let server, base, mongod;
const { app, mongoose } = require('../server');

// ── tiny http helper ──────────────────────────────────────────────────────────
function req(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const u = new URL(base + path);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        let parsed; try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}` + (extra ? `  →  ${JSON.stringify(extra)}` : '')); }
}

(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  try {
    // ── Auth ──
    console.log('\n── Auth ──');
    let r = await req('POST', '/api/register', { body: { email: 'host@test.com', password: 'secret1' } });
    check('register host', r.status === 200 && r.body.token, r.body);
    const hostTok = r.body.token;

    r = await req('POST', '/api/register', { body: { email: 'guest@test.com', password: 'secret1' } });
    const guestTok = r.body.token;
    check('register guest', !!guestTok);

    r = await req('GET', '/api/me', { token: guestTok });
    check('GET /api/me', r.status === 200 && r.body.email === 'guest@test.com', r.body);
    const guestId = r.body._id;

    r = await req('GET', '/api/me', { token: hostTok });
    const hostId = r.body._id;

    // ── Listing + F5 geocode + F7 gallery + F4 maxGuests ──
    console.log('\n── Listings (F4 guests, F5 geo, F7 gallery) ──');
    r = await req('POST', '/api/listings', { token: hostTok, body: {
      title: 'Sea View Flat', city: 'Kotor', price: 80, maxGuests: 3,
      images: ['/uploads/a.jpg', '/uploads/b.jpg'], amenities: ['WiFi', 'Sea view'],
    }});
    check('create listing', r.status === 200, r.body);
    const listing = r.body.listing;
    check('F5 geocoded lat/lng set', typeof listing.lat === 'number' && typeof listing.lng === 'number', { lat: listing.lat, lng: listing.lng });
    check('F7 gallery images[] stored', Array.isArray(listing.images) && listing.images.length === 2, listing.images);
    check('F4 maxGuests stored', listing.maxGuests === 3, listing.maxGuests);
    const lid = listing._id;

    r = await req('GET', `/api/listings?guests=3`);
    check('F4 filter listings by guests', r.status === 200 && r.body.some(l => l._id === lid), r.body.length);
    r = await req('GET', `/api/listings?guests=5`);
    check('F4 filter excludes too-many-guests', !r.body.some(l => l._id === lid));

    // ── F1 Favorites ──
    console.log('\n── F1 Favorites ──');
    r = await req('POST', `/api/favorites/${lid}`, { token: guestTok });
    check('add favorite', r.status === 200 && r.body.favorited, r.body);
    r = await req('POST', `/api/favorites/${lid}`, { token: guestTok });
    check('add favorite idempotent', r.status === 200, r.body);
    r = await req('GET', '/api/favorites', { token: guestTok });
    check('list favorites returns listing', r.status === 200 && r.body.length === 1 && r.body[0]._id === lid, r.body);
    r = await req('GET', '/api/favorites/ids', { token: guestTok });
    check('favorites/ids', r.status === 200 && r.body.includes(lid));
    r = await req('DELETE', `/api/favorites/${lid}`, { token: guestTok });
    check('remove favorite', r.status === 200 && !r.body.favorited);
    r = await req('GET', '/api/favorites', { token: guestTok });
    check('favorites empty after remove', r.body.length === 0);

    // ── F4 Booking with guests + validation ──
    console.log('\n── F4 Booking (guests) ──');
    r = await req('POST', '/api/bookings', { token: guestTok, body: { listingId: lid, checkIn: '2030-01-10', checkOut: '2030-01-12', guests: 5 } });
    check('reject booking over maxGuests', r.status === 400, r.body);
    r = await req('POST', '/api/bookings', { token: guestTok, body: { listingId: lid, checkIn: '2030-01-10', checkOut: '2030-01-12', guests: 2 } });
    check('create booking within guests', r.status === 200 && r.body.booking.guests === 2 && r.body.nights === 2, r.body);
    const bookingId = r.body.booking._id;
    check('booking starts pending', r.body.booking.status === 'pending');

    r = await req('POST', '/api/bookings', { token: guestTok, body: { listingId: lid, checkIn: '2030-01-11', checkOut: '2030-01-13', guests: 1 } });
    check('reject overlapping dates', r.status === 409, r.body);

    // ── F2 Host dashboard ──
    console.log('\n── F2 Host Dashboard ──');
    r = await req('GET', '/api/host/listings', { token: hostTok });
    check('host listings w/ counts', r.status === 200 && r.body.length === 1 && r.body[0].bookingCount === 1 && r.body[0].pendingCount === 1, r.body);
    r = await req('GET', '/api/host/listings', { token: guestTok });
    check('guest sees no host listings', r.status === 200 && r.body.length === 0);
    r = await req('GET', '/api/host/bookings', { token: hostTok });
    check('host sees incoming booking', r.status === 200 && r.body.length === 1 && r.body[0].userId.email === 'guest@test.com', r.body);

    r = await req('PATCH', `/api/host/bookings/${bookingId}/confirm`, { token: guestTok });
    check('non-owner cannot confirm', r.status === 403, r.body);
    r = await req('PATCH', `/api/host/bookings/${bookingId}/confirm`, { token: hostTok });
    check('host confirms booking', r.status === 200 && r.body.booking.status === 'confirmed', r.body);

    // ── Reviews (gated by booking) ──
    console.log('\n── Reviews ──');
    r = await req('POST', `/api/listings/${lid}/reviews`, { token: guestTok, body: { rating: 5, comment: 'Great!' } });
    check('guest can review booked listing', r.status === 200, r.body);
    r = await req('POST', `/api/listings/${lid}/reviews`, { token: hostTok, body: { rating: 1, comment: 'spam' } });
    check('non-booker cannot review', r.status === 403, r.body);

    // ── F2 listing edit ──
    console.log('\n── F2 Edit listing ──');
    r = await req('PATCH', `/api/listings/${lid}`, { token: hostTok, body: { price: 95, maxGuests: 6 } });
    check('owner edits listing', r.status === 200 && r.body.listing.price === 95 && r.body.listing.maxGuests === 6, r.body);
    r = await req('PATCH', `/api/listings/${lid}`, { token: guestTok, body: { price: 1 } });
    check('non-owner cannot edit', r.status === 403, r.body);

    // ── F6 Messaging ──
    console.log('\n── F6 Messaging ──');
    r = await req('POST', '/api/messages', { token: guestTok, body: { listingId: lid, body: 'Is parking included?' } });
    check('guest messages host', r.status === 200, r.body);
    r = await req('GET', '/api/messages/unread-count', { token: hostTok });
    check('host has 1 unread', r.status === 200 && r.body.count === 1, r.body);
    r = await req('POST', '/api/messages', { token: hostTok, body: { listingId: lid, toId: guestId, body: 'Yes, free parking!' } });
    check('host replies to guest', r.status === 200, r.body);
    r = await req('GET', '/api/messages/threads', { token: guestTok });
    check('guest sees 1 thread', r.status === 200 && r.body.length === 1 && r.body[0].listing._id === lid, r.body);
    r = await req('GET', `/api/messages/thread/${lid}/${hostId}`, { token: guestTok });
    check('conversation has 2 messages in order', r.status === 200 && r.body.length === 2 && r.body[0].body === 'Is parking included?', r.body.map(m => m.body));
    r = await req('GET', '/api/messages/unread-count', { token: guestTok });
    check('guest unread cleared after reading thread', r.body.count === 0, r.body);

    // ── F3 Stripe webhook auto-confirm ──
    console.log('\n── F3 Stripe webhook ──');
    // Simulate checkout.session.completed (no STRIPE_KEY -> stripe null, so webhook should 503)
    // We can still test confirmBookingFromCheckout logic path is wired by hitting the route.
    r = await req('POST', '/api/stripe/webhook', { body: { type: 'checkout.session.completed', data: { object: { metadata: {} } } } });
    check('webhook route exists (503 w/o stripe key OR 200)', r.status === 503 || r.status === 200, r.body);

    // ── Cleanup cascade ──
    console.log('\n── Delete cascade ──');
    r = await req('DELETE', `/api/listings/${lid}`, { token: hostTok });
    check('owner deletes listing', r.status === 200, r.body);
    r = await req('GET', '/api/host/bookings', { token: hostTok });
    check('bookings cascade-deleted', r.body.length === 0, r.body);

  } catch (e) {
    console.error('TEST CRASH:', e);
    failed++;
  } finally {
    console.log(`\n════════════════════════════\n  PASSED: ${passed}   FAILED: ${failed}\n════════════════════════════`);
    await mongoose.disconnect();
    await mongod.stop();
    server.close();
    process.exit(failed ? 1 : 0);
  }
})();
