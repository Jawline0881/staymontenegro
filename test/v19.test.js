// v19 feature tests: Revenue Dashboard, Email Notifications, Check-in Instructions
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
  else { failed++; console.log(`  ❌ ${name}` + (extra !== undefined ? `  →  ${JSON.stringify(extra)}` : '')); }
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
    r = await req('POST', '/api/register', { body: { email: 'host@v19.com', password: 'secret1' } });
    const hostTok = r.body.token;
    r = await req('GET', '/api/me', { token: hostTok });
    const hostId = r.body._id;

    r = await req('POST', '/api/register', { body: { email: 'guest@v19.com', password: 'secret1' } });
    const guestTok = r.body.token;
    r = await req('GET', '/api/me', { token: guestTok });
    const guestId = r.body._id;

    // Create instant_book listing so booking auto-confirms + creates payout
    r = await req('POST', '/api/listings', { token: hostTok, body: {
      title: 'Revenue Test Villa', city: 'Kotor', price: 100, maxGuests: 4,
      bookingMode: 'instant_book',
    }});
    const lid = r.body.listing._id;

    // Make a confirmed booking (instant_book auto-confirms)
    r = await req('POST', '/api/bookings', { token: guestTok, body: {
      listingId: lid, checkIn: '2030-07-01', checkOut: '2030-07-04', guests: 2,
    }});
    check('instant booking auto-confirms', r.body.booking?.status === 'confirmed', r.body.booking?.status);
    const bookingId = r.body.booking._id;
    const totalPrice = r.body.totalPrice; // Should be 300 (3 nights × €100)
    check('booking total is correct (3 nights × €100)', totalPrice === 300, totalPrice);

    // ── Feature 1: Revenue Dashboard ─────────────────────────────────────────
    console.log('\n── Revenue & Earnings Dashboard ──');

    r = await req('GET', '/api/host/revenue/summary', { token: hostTok });
    check('GET /api/host/revenue/summary works', r.status === 200, r.body);
    check('allTime earnings is 285 (300 - 5%)', r.body.allTime === 285, r.body.allTime);
    check('totalBookings is 1', r.body.totalBookings === 1, r.body.totalBookings);
    check('pendingPayout equals hostEarnings', r.body.pendingPayout === 285, r.body.pendingPayout);
    check('currency is EUR', r.body.currency === 'EUR', r.body.currency);
    check('listingCount is 1', r.body.listingCount === 1, r.body.listingCount);

    r = await req('GET', '/api/host/revenue/monthly', { token: hostTok });
    check('GET /api/host/revenue/monthly works', r.status === 200 && Array.isArray(r.body), r.body);
    check('monthly data has one entry', r.body.length === 1, r.body.length);
    check('monthly entry has earnings=285', r.body[0]?.earnings === 285, r.body[0]?.earnings);
    check('monthly entry has bookings=1', r.body[0]?.bookings === 1, r.body[0]?.bookings);
    check('monthly entry has year/month', r.body[0]?.year > 0 && r.body[0]?.month > 0, r.body[0]);

    r = await req('GET', '/api/host/revenue/by-listing', { token: hostTok });
    check('GET /api/host/revenue/by-listing works', r.status === 200 && Array.isArray(r.body), r.body);
    check('by-listing has one entry', r.body.length === 1, r.body.length);
    check('by-listing earnings=285', r.body[0]?.earnings === 285, r.body[0]?.earnings);
    check('by-listing has listing title', r.body[0]?.listing?.title === 'Revenue Test Villa', r.body[0]?.listing?.title);

    r = await req('GET', '/api/host/revenue/payouts', { token: hostTok });
    check('GET /api/host/revenue/payouts works', r.status === 200, r.body);
    check('payouts total is 1', r.body.total === 1, r.body.total);
    check('payout status is pending', r.body.payouts[0]?.status === 'pending', r.body.payouts[0]?.status);
    check('payout hostEarnings=285', r.body.payouts[0]?.hostEarnings === 285, r.body.payouts[0]?.hostEarnings);
    const payoutId = r.body.payouts[0]?._id;

    // Guest cannot see host revenue
    r = await req('GET', '/api/host/revenue/summary', { token: guestTok });
    check('guest revenue summary returns 0 (no listings)', r.status === 200 && r.body.allTime === 0, r.body);

    // Admin marks payout as paid
    const { models } = require('../server');
    const jwt = require('jsonwebtoken');
    const adminUser = await models.User.create({ email: 'admin@v19.com', password: 'x', isAdmin: true });
    const adminTok = jwt.sign({ id: adminUser._id, email: adminUser.email, isAdmin: true }, 'test-secret', { expiresIn: '1h' });

    r = await req('PATCH', `/api/admin/payouts/${payoutId}/mark-paid`, { token: adminTok });
    check('admin marks payout as paid', r.status === 200 && r.body.payout?.status === 'paid', r.body);

    // After mark-paid, pendingPayout should be 0
    r = await req('GET', '/api/host/revenue/summary', { token: hostTok });
    check('pendingPayout = 0 after mark-paid', r.body.pendingPayout === 0, r.body.pendingPayout);
    check('allTime still 285 after mark-paid', r.body.allTime === 285, r.body.allTime);

    r = await req('GET', '/api/admin/payouts/pending', { token: adminTok });
    check('admin pending payouts = 0 after mark-paid', r.status === 200 && r.body.length === 0, r.body.length);

    // ── Feature 2: Email in Notifications ────────────────────────────────────
    console.log('\n── Email in Notifications ──');

    // Notify() should still save to DB regardless of mailer
    const countBefore = await models.Notification.countDocuments({ userId: guestId });
    // Booking already triggered notifications — verify they exist in DB
    const guestNotifs = await models.Notification.find({ userId: guestId });
    check('booking_confirmed notification saved to DB', guestNotifs.some(n => n.type === 'booking_confirmed'), guestNotifs.map(n => n.type));

    const hostNotifs = await models.Notification.find({ userId: hostId });
    check('booking_request notification saved for host', hostNotifs.some(n => n.type === 'booking_request'), hostNotifs.map(n => n.type));

    // Notification API still works
    r = await req('GET', '/api/notifications', { token: guestTok });
    check('GET /api/notifications includes booking_confirmed', r.status === 200 && r.body.notifications?.some(n => n.type === 'booking_confirmed'), r.body.notifications?.map(n => n.type));

    r = await req('GET', '/api/notifications/unread-count', { token: guestTok });
    check('unread-count endpoint still works', r.status === 200 && typeof r.body.count === 'number', r.body);

    // ── Feature 3: Check-in Instructions ─────────────────────────────────────
    console.log('\n── Check-in Instructions ──');

    // Host sets instructions
    r = await req('PUT', `/api/listings/${lid}/checkin-instructions`, { token: hostTok, body: {
      accessCode:       '1234#',
      wifiNetwork:      'GuestWifi',
      wifiPassword:     'welcome2030',
      checkInTime:      '3:00 PM',
      checkOutTime:     '11:00 AM',
      directions:       'Turn left at the blue gate.',
      emergencyContact: '+382 67 123456',
      additionalNotes:  'Please leave windows closed.',
      revealHoursBeforeCheckin: 48,
    }});
    check('host saves check-in instructions', r.status === 200, r.body);
    check('accessCode saved', r.body.instructions?.accessCode === '1234#', r.body.instructions?.accessCode);
    check('revealHours saved as 48', r.body.instructions?.revealHoursBeforeCheckin === 48, r.body.instructions?.revealHoursBeforeCheckin);

    // Host can view their own instructions
    r = await req('GET', `/api/listings/${lid}/checkin-instructions`, { token: hostTok });
    check('host can view own instructions', r.status === 200 && r.body.wifiPassword === 'welcome2030', r.body.wifiPassword);

    // Non-host cannot view instructions via host endpoint
    r = await req('GET', `/api/listings/${lid}/checkin-instructions`, { token: guestTok });
    check('non-host cannot view host instructions', r.status === 403, r.body);

    // Guest booking is in 2030 (far future) — too early to reveal
    r = await req('GET', `/api/bookings/${bookingId}/checkin-instructions`, { token: guestTok });
    check('instructions not revealed before window (far-future booking)', r.status === 200 && r.body.available === false, r.body);
    check('revealAt timestamp provided', !!r.body.revealAt, r.body.revealAt);
    check('helpful message in response', typeof r.body.message === 'string', r.body.message);

    // Update booking to be a past checkin (within window) so instructions reveal
    await models.Booking.findByIdAndUpdate(bookingId, {
      checkIn:  new Date(Date.now() - 10 * 3600000),   // 10h ago (past check-in)
      checkOut: new Date(Date.now() + 24 * 3600000),   // still ongoing
    });
    r = await req('GET', `/api/bookings/${bookingId}/checkin-instructions`, { token: guestTok });
    check('instructions revealed when within window', r.status === 200 && r.body.available === true, r.body);
    check('accessCode visible to guest', r.body.instructions?.accessCode === '1234#', r.body.instructions?.accessCode);
    check('wifi password visible to guest', r.body.instructions?.wifiPassword === 'welcome2030', r.body.instructions?.wifiPassword);

    // Non-owner guest cannot view other booking's instructions
    r = await req('POST', '/api/register', { body: { email: 'other@v19.com', password: 'secret1' } });
    const otherTok = r.body.token;
    r = await req('GET', `/api/bookings/${bookingId}/checkin-instructions`, { token: otherTok });
    check('other user cannot view booking instructions', r.status === 403, r.body);

    // Pending booking cannot access instructions
    r = await req('POST', '/api/listings', { token: hostTok, body: {
      title: 'Pending Flat', city: 'Bar', price: 60, maxGuests: 2, bookingMode: 'request_to_book',
    }});
    const pendingLid = r.body.listing._id;
    r = await req('POST', '/api/bookings', { token: guestTok, body: {
      listingId: pendingLid, checkIn: '2030-08-01', checkOut: '2030-08-03', guests: 1,
    }});
    const pendingBookingId = r.body.booking._id;
    r = await req('GET', `/api/bookings/${pendingBookingId}/checkin-instructions`, { token: guestTok });
    check('pending booking cannot access instructions', r.status === 403, r.body);

    // Upsert: updating instructions overwrites
    r = await req('PUT', `/api/listings/${lid}/checkin-instructions`, { token: hostTok, body: {
      accessCode: '9999#', wifiPassword: 'newpassword',
    }});
    check('instructions upsert works', r.status === 200 && r.body.instructions?.accessCode === '9999#', r.body.instructions?.accessCode);

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
