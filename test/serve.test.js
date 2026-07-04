// Boots a real in-memory Mongo, starts the server via MONGO_URL env, then
// curls every static page + exercises a live end-to-end user flow.
const { MongoMemoryServer } = require('mongodb-memory-server');
const { spawn } = require('child_process');
const http = require('http');

function get(base, path, opts = {}) {
  return new Promise((res, rej) => {
    const u = new URL(base + path);
    const data = opts.body ? JSON.stringify(opts.body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (opts.token) headers.Authorization = opts.token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method || 'GET', headers }, resp => {
      let c = ''; resp.on('data', d => c += d);
      resp.on('end', () => { let p; try { p = JSON.parse(c); } catch { p = c; } res({ status: resp.statusCode, body: p, raw: c }); });
    });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  const PORT = 4123;
  const srv = spawn('node', ['server.js'], { cwd: __dirname + '/..', env: { ...process.env, MONGO_URL: uri, PORT: String(PORT), COUNTRY: 'Serbia' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', d => log += d);
  srv.stderr.on('data', d => log += d);

  const base = `http://127.0.0.1:${PORT}`;
  // wait for server
  for (let i = 0; i < 40; i++) { try { const r = await get(base, '/api/amenities'); if (r.status === 200) break; } catch {} await sleep(250); }

  let pass = 0, fail = 0;
  const check = (n, c, e) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}  → ${JSON.stringify(e)}`));

  try {
    console.log('\n── Static pages serve (200 + has expected markers) ──');
    const pages = [
      ['/', 'StayMontenegro'],
      ['/add.html', 'Max guests'],
      ['/listing.html', 'gallery-main'],
      ['/saved.html', 'Saved Listings'],
      ['/host.html', 'Host Dashboard'],
      ['/messages.html', 'Messages'],
      ['/mybookings.html', 'My Bookings'],
      ['/admin.html', 'Admin'],
      ['/nav.js', 'favHelper'],
      ['/style.css', '.card'],
    ];
    for (const [p, marker] of pages) {
      const r = await get(base, p);
      check(`GET ${p}`, r.status === 200 && r.raw.includes(marker), { status: r.status, hasMarker: r.raw.includes(marker) });
    }

    console.log('\n── Live end-to-end flow ──');
    let r = await get(base, '/api/register', { method: 'POST', body: { email: 'host@x.com', password: 'pass12' } });
    const hostTok = r.body.token; check('register host', !!hostTok);
    r = await get(base, '/api/register', { method: 'POST', body: { email: 'guest@x.com', password: 'pass12' } });
    const guestTok = r.body.token; check('register guest', !!guestTok);

    r = await get(base, '/api/listings', { method: 'POST', token: hostTok, body: { title: 'Belgrade Loft', city: 'Belgrade', price: 70, maxGuests: 2, images: ['/uploads/x.jpg','/uploads/y.jpg'] } });
    check('create listing (live geocode)', r.status === 200, r.body?.error);
    const lid = r.body.listing._id;
    check('listing geocoded via live nominatim', typeof r.body.listing.lat === 'number', { lat: r.body.listing.lat, lng: r.body.listing.lng });
    check('gallery stored', r.body.listing.images.length === 2);

    r = await get(base, `/api/favorites/${lid}`, { method: 'POST', token: guestTok });
    check('favorite', r.status === 200);
    r = await get(base, '/api/favorites', { token: guestTok });
    check('favorites list', r.body.length === 1);

    r = await get(base, '/api/bookings', { method: 'POST', token: guestTok, body: { listingId: lid, checkIn: '2031-05-01', checkOut: '2031-05-03', guests: 2 } });
    check('book within guests', r.status === 200 && r.body.booking.guests === 2, r.body?.error);

    r = await get(base, '/api/host/bookings', { token: hostTok });
    check('host sees booking', r.body.length === 1);
    r = await get(base, `/api/host/bookings/${r.body[0]._id}/confirm`, { method: 'PATCH', token: hostTok });
    check('host confirms', r.status === 200 && r.body.booking.status === 'confirmed');

    r = await get(base, '/api/messages', { method: 'POST', token: guestTok, body: { listingId: lid, body: 'Hello!' } });
    check('guest messages host', r.status === 200, r.body?.error);
    r = await get(base, '/api/messages/threads', { token: hostTok });
    check('host has thread', r.body.length === 1);

  } catch (e) { console.error('CRASH', e); fail++; }
  finally {
    console.log(`\n  PASSED: ${pass}  FAILED: ${fail}`);
    if (fail) console.log('\n--- server log ---\n' + log.slice(-1500));
    srv.kill(); await mongod.stop();
    process.exit(fail ? 1 : 0);
  }
})();
