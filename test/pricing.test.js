// Tests for Feature #1 (seasonal pricing) + Feature #7 (date-range search).
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';

const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');
global.fetch = async (url) => ({ json: async () => String(url).includes('nominatim') ? [{ lat: '44.78', lon: '20.44' }] : [] });

const { app, mongoose } = require('../server');

function req(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const u = new URL(base + path);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, res => {
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
    let r = await req('POST', '/api/register', { body: { email: 'host@t.com', password: 'secret1' } });
    const hostTok = r.body.token;
    r = await req('POST', '/api/register', { body: { email: 'guest@t.com', password: 'secret1' } });
    const guestTok = r.body.token;

    // ── Create listing WITH seasonal rules: base €100, summer €200 (Jul 2030) ──
    console.log('\n── #1 Seasonal pricing ──');
    r = await req('POST', '/api/listings', { token: hostTok, body: {
      title: 'Seasonal Villa', city: 'Belgrade', price: 100, maxGuests: 4,
      pricingRules: [
        { label: 'Summer', start: '2030-07-01', end: '2030-08-01', price: 200 },
        { label: 'New Year', start: '2030-12-30', end: '2031-01-02', price: 350 },
      ],
    }});
    check('listing created with rules', r.status === 200 && r.body.listing.pricingRules.length === 2, r.body?.error);
    const lid = r.body.listing._id;

    // Quote a pure-base stay (June): 3 nights * 100 = 300
    r = await req('GET', `/api/listings/${lid}/quote?checkIn=2030-06-10&checkOut=2030-06-13`);
    check('base-only quote: 3 nights = €300', r.body.nights === 3 && r.body.total === 300, r.body);
    check('base quote breakdown is single Base segment', r.body.breakdown.length === 1 && r.body.breakdown[0].label === 'Base', r.body.breakdown);

    // Quote a pure-summer stay (July): 4 nights * 200 = 800
    r = await req('GET', `/api/listings/${lid}/quote?checkIn=2030-07-10&checkOut=2030-07-14`);
    check('summer quote: 4 nights = €800', r.body.nights === 4 && r.body.total === 800, r.body);
    check('summer avgNightly = 200', r.body.avgNightly === 200, r.body.avgNightly);

    // Quote a stay that STRADDLES base->summer: Jun30(base 100) + Jul1,Jul2(summer 200) = 100+200+200=500
    r = await req('GET', `/api/listings/${lid}/quote?checkIn=2030-06-30&checkOut=2030-07-03`);
    check('straddle quote: €500 over 3 nights', r.body.nights === 3 && r.body.total === 500, r.body);
    check('straddle has 2 breakdown segments', r.body.breakdown.length === 2, r.body.breakdown);
    check('straddle segment 1 = 1 base night', r.body.breakdown[0].label === 'Base' && r.body.breakdown[0].nights === 1, r.body.breakdown[0]);
    check('straddle segment 2 = 2 summer nights', r.body.breakdown[1].label === 'Summer' && r.body.breakdown[1].nights === 2, r.body.breakdown[1]);

    // ── Booking total respects seasonal pricing ──
    console.log('\n── #1 Booking total is seasonal-aware ──');
    r = await req('POST', '/api/bookings', { token: guestTok, body: { listingId: lid, checkIn: '2030-07-10', checkOut: '2030-07-13', guests: 2 } });
    check('summer booking total = €600 (3*200)', r.status === 200 && r.body.booking.totalPrice === 600, r.body);

    // ── #7 Date-range search ──
    console.log('\n── #7 Date-range search ──');
    // Add a second always-available listing
    r = await req('POST', '/api/listings', { token: hostTok, body: { title: 'Plain Flat', city: 'Belgrade', price: 50, maxGuests: 2 } });
    const lid2 = r.body.listing._id;

    // Search overlapping the existing July 10-13 booking on villa -> villa excluded, flat present
    r = await req('GET', '/api/listings?checkIn=2030-07-11&checkOut=2030-07-12');
    const ids = r.body.map(l => l._id);
    check('booked villa excluded from date search', !ids.includes(lid), ids);
    check('available flat included', ids.includes(lid2), ids);
    check('date-search results carry a quote', r.body.every(l => l.quote && typeof l.quote.total === 'number'), r.body.map(l => !!l.quote));

    // Search a free window -> both present, villa quote should be summer-priced
    r = await req('GET', '/api/listings?checkIn=2030-07-20&checkOut=2030-07-22');
    const villa = r.body.find(l => l._id === lid);
    check('free window returns villa', !!villa, r.body.map(l => l.title));
    check('villa quote in July = €400 (2*200)', villa && villa.quote.total === 400, villa?.quote);

    // No-date search returns everything WITHOUT quote attached
    r = await req('GET', '/api/listings');
    check('plain search returns all, no quote field', r.body.length === 2 && r.body.every(l => l.quote === undefined), r.body.map(l => !!l.quote));

    // ── PATCH updates rules ──
    console.log('\n── #1 Edit rules ──');
    r = await req('PATCH', `/api/listings/${lid}`, { token: hostTok, body: { pricingRules: [{ label: 'Winter', start: '2030-12-01', end: '2030-12-15', price: 80 }] } });
    check('rules replaced via PATCH', r.status === 200 && r.body.listing.pricingRules.length === 1 && r.body.listing.pricingRules[0].label === 'Winter', r.body?.listing?.pricingRules);

    // Invalid rule (end<=start, negative price) is dropped
    r = await req('PATCH', `/api/listings/${lid}`, { token: hostTok, body: { pricingRules: [
      { label: 'Bad', start: '2030-05-10', end: '2030-05-10', price: 100 },   // zero-length
      { label: 'Neg', start: '2030-06-01', end: '2030-06-05', price: -5 },     // negative
      { label: 'Good', start: '2030-09-01', end: '2030-09-10', price: 120 },
    ] } });
    check('invalid rules filtered, only Good kept', r.body.listing.pricingRules.length === 1 && r.body.listing.pricingRules[0].label === 'Good', r.body.listing.pricingRules);

  } catch (e) { console.error('CRASH', e); failed++; }
  finally {
    console.log(`\n  PASSED: ${passed}  FAILED: ${failed}`);
    await mongoose.disconnect(); await mongod.stop(); server.close();
    process.exit(failed ? 1 : 0);
  }
})();
