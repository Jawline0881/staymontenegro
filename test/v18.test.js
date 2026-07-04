// v18 feature tests: Instant Book, Two-Way Reviews, Superhost
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';

const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');

global.fetch = async (url) => ({
  json: async () => {
    if (String(url).includes('nominatim')) return [{ lat: '42.4304', lon: '18.7712' }];
    return [];
  },
});

let server, base, mongod;
const { app, mongoose } = require('../server');

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
    // Setup: register host + guest
    let r;
    r = await req('POST', '/api/register', { body: { email: 'host@v18.com', password: 'secret1' } });
    const hostTok = r.body.token;
    r = await req('GET', '/api/me', { token: hostTok });
    const hostId = r.body._id;

    r = await req('POST', '/api/register', { body: { email: 'guest@v18.com', password: 'secret1' } });
    const guestTok = r.body.token;
    r = await req('GET', '/api/me', { token: guestTok });
    const guestId = r.body._id;

    // ── Feature 1: Instant Book ──────────────────────────────────────────────
    console.log('\n── Instant Book ──');

    // Create request_to_book listing (default)
    r = await req('POST', '/api/listings', { token: hostTok, body: {
      title: 'Request Flat', city: 'Kotor', price: 80, maxGuests: 4,
      bookingMode: 'request_to_book',
    }});
    check('create request_to_book listing', r.status === 200, r.body);
    check('bookingMode stored as request_to_book', r.body.listing.bookingMode === 'request_to_book', r.body.listing.bookingMode);
    const reqLid = r.body.listing._id;

    // Create instant_book listing
    r = await req('POST', '/api/listings', { token: hostTok, body: {
      title: 'Instant Villa', city: 'Budva', price: 120, maxGuests: 4,
      bookingMode: 'instant_book',
    }});
    check('create instant_book listing', r.status === 200, r.body);
    check('bookingMode stored as instant_book', r.body.listing.bookingMode === 'instant_book', r.body.listing.bookingMode);
    const instLid = r.body.listing._id;

    // Booking on request_to_book → starts pending
    r = await req('POST', '/api/bookings', { token: guestTok, body: {
      listingId: reqLid, checkIn: '2030-03-01', checkOut: '2030-03-03', guests: 1,
    }});
    check('request_to_book booking starts pending', r.status === 200 && r.body.booking.status === 'pending', r.body);
    const reqBookingId = r.body.booking._id;

    // Booking on instant_book → auto-confirmed
    r = await req('POST', '/api/bookings', { token: guestTok, body: {
      listingId: instLid, checkIn: '2030-04-01', checkOut: '2030-04-03', guests: 1,
    }});
    check('instant_book booking auto-confirmed', r.status === 200 && r.body.booking.status === 'confirmed', r.body);
    const instBookingId = r.body.booking._id;

    // Switch listing from request_to_book to instant_book via PATCH
    r = await req('PATCH', `/api/listings/${reqLid}`, { token: hostTok, body: { bookingMode: 'instant_book' } });
    check('PATCH bookingMode to instant_book', r.status === 200 && r.body.listing.bookingMode === 'instant_book', r.body);

    // Invalid bookingMode rejected
    r = await req('PATCH', `/api/listings/${reqLid}`, { token: hostTok, body: { bookingMode: 'super_fast' } });
    check('invalid bookingMode ignored (keeps old)', r.status === 200 && r.body.listing.bookingMode === 'instant_book', r.body.listing.bookingMode);

    // ── Feature 2: Two-Way Reviews ───────────────────────────────────────────
    console.log('\n── Two-Way Reviews (Host → Guest) ──');

    // Host tries to review guest on future booking (checkOut in future) — should fail
    r = await req('POST', `/api/bookings/${instBookingId}/guest-review`, { token: hostTok, body: { rating: 5, comment: 'Great guest!' } });
    check('cannot review guest before checkout', r.status === 400, r.body);

    // We need a past booking to test — manipulate dates via direct DB
    const { models } = require('../server');
    const pastCheckIn  = new Date('2024-01-01');
    const pastCheckOut = new Date('2024-01-03');
    await models.Booking.findByIdAndUpdate(instBookingId, { checkIn: pastCheckIn, checkOut: pastCheckOut });

    // Now host can review guest
    r = await req('POST', `/api/bookings/${instBookingId}/guest-review`, { token: hostTok, body: {
      rating: 4, comment: 'Very clean and polite.', communication: 5, cleanliness: 4, houseRules: 5,
    }});
    check('host reviews guest after checkout', r.status === 200, r.body);
    check('guest review has rating', r.body.review?.rating === 4, r.body.review);
    check('guest review has sub-ratings', r.body.review?.communication === 5, r.body.review);

    // Duplicate guest review rejected
    r = await req('POST', `/api/bookings/${instBookingId}/guest-review`, { token: hostTok, body: { rating: 3, comment: 'Second try' } });
    check('duplicate guest review rejected (409)', r.status === 409, r.body);

    // Non-host cannot review guest
    r = await req('POST', `/api/bookings/${instBookingId}/guest-review`, { token: guestTok, body: { rating: 5, comment: 'Self review' } });
    check('non-host cannot review guest', r.status === 403, r.body);

    // Guest can see their own reviews
    r = await req('GET', `/api/users/${guestId}/guest-reviews`);
    check('public guest reviews visible', r.status === 200 && r.body.length === 1, r.body);
    check('guest review has correct rating', r.body[0]?.rating === 4, r.body[0]);

    // Host: list reviews they wrote
    r = await req('GET', '/api/host/guest-reviews', { token: hostTok });
    check('host can list their guest reviews', r.status === 200 && r.body.length === 1, r.body);

    // Booking flagged as host-reviewed
    r = await req('GET', '/api/bookings/mine', { token: guestTok });
    const reviewed = r.body.find(b => b._id === instBookingId);
    check('booking.hostReviewedGuest = true after review', reviewed?.hostReviewedGuest === true, reviewed);

    // ── Feature 3: Superhost Badge ───────────────────────────────────────────
    console.log('\n── Superhost Badge System ──');

    // Freshly registered host should not be superhost
    r = await req('GET', `/api/users/${hostId}/superhost-stats`);
    check('GET superhost-stats endpoint works', r.status === 200, r.body);
    check('new host is not superhost', r.body.isSuperhost === false, r.body.isSuperhost);
    check('superhost thresholds returned', r.body.thresholds?.minAvgRating === 4.8, r.body.thresholds);

    // Admin recalc endpoint exists
    const adminR = await req('POST', '/api/register', { body: { email: 'admin@v18.com', password: 'adminpass' } });
    const adminTok = adminR.body.token;
    const { models: m } = require('../server');
    const adminUser = await m.User.findOne({ email: 'admin@v18.com' });
    await m.User.findByIdAndUpdate(adminUser._id, { isAdmin: true });
    const adminTokFresh = require('jsonwebtoken').sign({ id: adminUser._id, email: adminUser.email, isAdmin: true }, 'test-secret', { expiresIn: '1h' });

    r = await req('POST', '/api/admin/recalc-superhosts', { token: adminTokFresh });
    check('admin can trigger superhost recalc', r.status === 200, r.body);
    check('recalc message returned', typeof r.body.message === 'string', r.body.message);

    // ── Profile endpoints ─────────────────────────────────────────────────────
    console.log('\n── Public Host Profile ──');

    r = await req('GET', `/api/users/${hostId}/profile`);
    check('GET /api/users/:id/profile works', r.status === 200, r.body);
    check('profile has user object', r.body.user?._id === hostId, r.body.user);
    check('profile has listings array', Array.isArray(r.body.listings), r.body.listings);
    check('profile has reviewCount', typeof r.body.reviewCount === 'number', r.body.reviewCount);
    check('profile does not expose password', !r.body.user?.password, r.body.user);
    check('profile includes isSuperhost', 'isSuperhost' in r.body.user, r.body.user);

    // Update own profile
    r = await req('PATCH', '/api/me/profile', { token: hostTok, body: { displayName: 'Marko Host', bio: 'Friendly host in Montenegro', location: 'Kotor' } });
    check('PATCH /api/me/profile works', r.status === 200, r.body);
    check('displayName updated', r.body.user?.displayName === 'Marko Host', r.body.user);
    check('bio updated', r.body.user?.bio === 'Friendly host in Montenegro', r.body.user);

    // Profile now shows updated name
    r = await req('GET', `/api/users/${hostId}/profile`);
    check('profile shows updated displayName', r.body.user?.displayName === 'Marko Host', r.body.user);

  } catch (e) {
    console.error('TEST CRASH:', e);
    failed++;
  } finally {
    const total = passed + failed;
    console.log(`\n════════════════════════════\n  PASSED: ${passed}   FAILED: ${failed}   TOTAL: ${total}\n════════════════════════════`);
    await mongoose.disconnect();
    await mongod.stop();
    server.close();
    process.exit(failed ? 1 : 0);
  }
})();
