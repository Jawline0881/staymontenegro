// test/seed.test.js — verify seed script runs cleanly against in-memory Mongo
process.env.NODE_ENV = 'seed';
process.env.JWT_SECRET = 'test-secret';

global.fetch = async (url) => ({
  json: async () => {
    if (String(url).includes('nominatim')) return [{ lat: '42.4304', lon: '18.7712' }];
    return [];
  },
});

const { MongoMemoryServer } = require('mongodb-memory-server');

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGO_URL = mongod.getUri();

  const { seed } = require('../seed.js');
  await seed();

  // Seed disconnects — reconnect for verification
  const { models, mongoose } = require('../server');
  await mongoose.connect(mongod.getUri());

  const users    = await models.User.countDocuments();
  const listings = await models.Listing.countDocuments();
  const bookings = await models.Booking.countDocuments();
  const reviews  = await models.Review.countDocuments();
  const payouts  = await models.Payout.countDocuments();

  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ✅', name); }
    else      { fail++; console.log('  ❌', name, extra !== undefined ? `→ ${JSON.stringify(extra)}` : ''); }
  };

  check('users seeded (4)',    users === 4,    users);
  check('listings seeded (6)', listings === 6, listings);
  check('bookings seeded (8)', bookings === 8, bookings);
  check('reviews seeded (6+)', reviews >= 6,   reviews);
  check('payouts seeded (5+)', payouts >= 5,   payouts);

  const ana = await models.User.findOne({ email: 'ana@demo.com' });
  check('ana is superhost',            ana?.isSuperhost === true);
  check('ana has superhostStats',      ana?.superhostStats?.totalBookings > 0);

  const guest = await models.User.findOne({ email: 'guest@demo.com' });
  check('guest account created', !!guest);
  if (guest) {
    const favCount = await models.Favorite.countDocuments({ userId: guest._id });
    check('guest has 3 favorites', favCount === 3, favCount);
  }

  const admin = await models.User.findOne({ email: 'admin@demo.com' });
  check('admin account created', admin?.isAdmin === true);

  const rules  = await models.HouseRule.countDocuments();
  check('house rules created (2)', rules >= 2, rules);

  const instrs = await models.CheckinInstruction.countDocuments();
  check('checkin instructions created (2)', instrs >= 2, instrs);

  const notifs = await models.Notification.countDocuments();
  check('notifications created', notifs >= 3, notifs);

  // Verify instant_book listings exist
  const instantCount = await models.Listing.countDocuments({ bookingMode: 'instant_book' });
  check('instant_book listings exist', instantCount >= 3, instantCount);

  // Verify confirmed bookings exist
  const confirmed = await models.Booking.countDocuments({ status: 'confirmed' });
  check('confirmed bookings exist', confirmed >= 4, confirmed);

  console.log(`\n════════════════════════════\n  PASSED: ${pass}   FAILED: ${fail}\n════════════════════════════`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch(err => {
  console.error('CRASH:', err);
  process.exit(1);
});
