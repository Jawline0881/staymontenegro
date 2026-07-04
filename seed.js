#!/usr/bin/env node
/**
 * seed.js — Demo data for StayMontenegro
 * Usage:  MONGO_URL=mongodb://... node seed.js
 *         node seed.js  (uses localhost default)
 *
 * Creates:
 *  - 2 host accounts + 1 guest account + 1 admin account
 *  - 6 listings across Montenegro (Kotor, Budva, Tivat, Ulcinj, Perast, Herceg Novi)
 *  - ~8 confirmed bookings with realistic dates
 *  - Reviews on each listing
 *  - Check-in instructions for each listing
 *  - Payout records
 *  - House rules for 2 listings
 *  - Notifications
 *
 * Safe to run multiple times — wipes existing demo data first.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/staymontenegro';

// ── Pull all models from the app ─────────────────────────────────────────────
process.env.NODE_ENV = 'seed'; // skip auto-connect in server.js
const { models } = require('./server');
const { User, Listing, Booking, Review, Favorite, Notification, HouseRule, CheckinInstruction, Payout, Cancellation } = models;

// ── Helpers ───────────────────────────────────────────────────────────────────
function d(yearsAgo, month, day) {
  const now = new Date();
  return new Date(now.getFullYear() - (yearsAgo || 0), (month || 1) - 1, day || 1);
}
function past(daysAgo)   { return new Date(Date.now() - daysAgo * 86400000); }
function future(daysAhead) { return new Date(Date.now() + daysAhead * 86400000); }

// ── Listing images (free Unsplash photos sized for cards) ─────────────────────
const PHOTOS = {
  kotor:    'https://images.unsplash.com/photo-1555952494-efd681c7e3f9?w=800&q=80',
  budva:    'https://images.unsplash.com/photo-1571406252241-db0280bd36cd?w=800&q=80',
  tivat:    'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800&q=80',
  ulcinj:   'https://images.unsplash.com/photo-1499793983690-e29da59ef1c2?w=800&q=80',
  perast:   'https://images.unsplash.com/photo-1520637836862-4d197d17c93a?w=800&q=80',
  herceg:   'https://images.unsplash.com/photo-1582268611958-ebfd161ef9cf?w=800&q=80',
};

async function seed() {
  await mongoose.connect(MONGO_URL);

  // ── Wipe demo accounts (leave real data untouched) ─────────────────────────
  const demoEmails = [
    'ana@demo.com', 'marko@demo.com', 'guest@demo.com', 'admin@demo.com',
  ];
  const existing = await User.find({ email: { $in: demoEmails } }, '_id');
  const existingIds = existing.map(u => u._id);
  if (existingIds.length) {
    const listingDocs = await Listing.find({ ownerId: { $in: existingIds } }, '_id');
    const lids = listingDocs.map(l => l._id);
    await Promise.all([
      Listing.deleteMany({ ownerId: { $in: existingIds } }),
      Booking.deleteMany({ userId: { $in: existingIds } }),
      Review.deleteMany({ userId: { $in: existingIds } }),
      Favorite.deleteMany({ userId: { $in: existingIds } }),
      Notification.deleteMany({ userId: { $in: existingIds } }),
      HouseRule.deleteMany({ listingId: { $in: lids } }),
      CheckinInstruction.deleteMany({ listingId: { $in: lids } }),
      Payout.deleteMany({ hostId: { $in: existingIds } }),
      User.deleteMany({ email: { $in: demoEmails } }),
    ]);
    console.log('🗑️  Cleared existing demo data');
  }

  // ── Create users ──────────────────────────────────────────────────────────
  const pw = await bcrypt.hash('demo1234', 10);

  const ana = await User.create({
    email: 'ana@demo.com', password: pw,
    displayName: 'Ana Petrović',
    bio: 'I love hosting travellers and showing them the beauty of Montenegro. Born in Kotor, living by the sea.',
    location: 'Kotor, Montenegro',
    avatar: 'https://i.pravatar.cc/150?img=47',
    isEmailVerified: true,
  });

  const marko = await User.create({
    email: 'marko@demo.com', password: pw,
    displayName: 'Marko Đurović',
    bio: 'Property owner in Budva and Tivat. I focus on clean, modern stays close to the beach.',
    location: 'Budva, Montenegro',
    avatar: 'https://i.pravatar.cc/150?img=12',
    isEmailVerified: true,
  });

  const guest = await User.create({
    email: 'guest@demo.com', password: pw,
    displayName: 'Sofia Rossi',
    bio: 'Traveller from Italy. Love the Adriatic!',
    avatar: 'https://i.pravatar.cc/150?img=25',
    isEmailVerified: true,
  });

  const admin = await User.create({
    email: 'admin@demo.com', password: pw,
    displayName: 'Admin',
    isAdmin: true,
    isEmailVerified: true,
  });

  console.log('👤 Created: ana@demo.com, marko@demo.com, guest@demo.com, admin@demo.com (pw: demo1234)');

  // ── Create listings ───────────────────────────────────────────────────────
  const listings = await Listing.insertMany([
    {
      title: 'Sea View Apartment, Kotor Old Town',
      city: 'Kotor',
      description: 'Stunning apartment inside the medieval walls of Kotor Old Town. Wake up to panoramic views of the Bay of Kotor. Walking distance to all restaurants and the fortress trail.',
      image: PHOTOS.kotor,
      images: [PHOTOS.kotor, PHOTOS.tivat, PHOTOS.perast],
      price: 95,
      maxGuests: 4,
      amenities: ['WiFi', 'Air conditioning', 'Balcony', 'Sea view', 'Kitchen'],
      lat: 42.4236, lng: 18.7711,
      pricingRules: [
        { label: 'Summer Peak', start: new Date('2025-07-01'), end: new Date('2025-09-01'), price: 140 },
        { label: 'Summer Peak', start: new Date('2026-07-01'), end: new Date('2026-09-01'), price: 145 },
      ],
      cancellationPolicy: 'moderate',
      bookingMode: 'instant_book',
      avgRating: 4.9, reviewCount: 14,
      ownerId: ana._id,
    },
    {
      title: 'Perast Waterfront Studio',
      city: 'Perast',
      description: 'Romantic studio right on the waterfront of Perast, the most picturesque village in Montenegro. Boat hire available. Perfect for couples.',
      image: PHOTOS.perast,
      images: [PHOTOS.perast, PHOTOS.kotor],
      price: 75,
      maxGuests: 2,
      amenities: ['WiFi', 'Sea view', 'Balcony', 'Air conditioning'],
      lat: 42.4860, lng: 18.6967,
      cancellationPolicy: 'flexible',
      bookingMode: 'instant_book',
      avgRating: 5.0, reviewCount: 8,
      ownerId: ana._id,
    },
    {
      title: 'Modern Beach Villa, Budva Riviera',
      city: 'Budva',
      description: 'Sleek modern villa 200m from Budva beach. Private pool, outdoor BBQ area, and breathtaking Adriatic views. Perfect for families or a group of friends.',
      image: PHOTOS.budva,
      images: [PHOTOS.budva, PHOTOS.herceg, PHOTOS.ulcinj],
      price: 220,
      maxGuests: 8,
      amenities: ['WiFi', 'Pool', 'Parking', 'Air conditioning', 'Kitchen', 'Balcony', 'Sea view', 'Washing machine'],
      lat: 42.2780, lng: 18.8336,
      pricingRules: [
        { label: 'High Season', start: new Date('2025-06-15'), end: new Date('2025-09-15'), price: 320 },
        { label: 'High Season', start: new Date('2026-06-15'), end: new Date('2026-09-15'), price: 330 },
      ],
      cancellationPolicy: 'strict',
      bookingMode: 'request_to_book',
      avgRating: 4.8, reviewCount: 22,
      ownerId: marko._id,
    },
    {
      title: 'Porto Montenegro Luxury Suite',
      city: 'Tivat',
      description: 'Luxurious suite in the heart of Porto Montenegro marina. Walk to superyachts, world-class restaurants, and duty-free shopping. The most glamorous address in Montenegro.',
      image: PHOTOS.tivat,
      images: [PHOTOS.tivat, PHOTOS.budva],
      price: 180,
      maxGuests: 2,
      amenities: ['WiFi', 'Air conditioning', 'TV', 'Sea view', 'Kitchen'],
      lat: 42.4307, lng: 18.7046,
      cancellationPolicy: 'moderate',
      bookingMode: 'instant_book',
      avgRating: 4.7, reviewCount: 11,
      ownerId: marko._id,
    },
    {
      title: 'Ulcinj Old Town Guesthouse',
      city: 'Ulcinj',
      description: 'Authentic stone guesthouse in Ulcinj Old Town, the southernmost city of Montenegro. Within walking distance of Long Beach (Velika Plaža) — one of the longest beaches in the Adriatic.',
      image: PHOTOS.ulcinj,
      images: [PHOTOS.ulcinj, PHOTOS.budva],
      price: 55,
      maxGuests: 6,
      amenities: ['WiFi', 'Kitchen', 'Parking', 'Air conditioning', 'Pets allowed'],
      lat: 41.9243, lng: 19.2098,
      cancellationPolicy: 'flexible',
      bookingMode: 'instant_book',
      avgRating: 4.6, reviewCount: 17,
      ownerId: ana._id,
    },
    {
      title: 'Herceg Novi Bay View Apartment',
      city: 'Herceg Novi',
      description: 'Light-filled apartment with incredible views over the Bay of Kotor from the city of flowers. Close to Kanli Kula fortress and the waterfront promenade.',
      image: PHOTOS.herceg,
      images: [PHOTOS.herceg, PHOTOS.kotor],
      price: 70,
      maxGuests: 3,
      amenities: ['WiFi', 'Balcony', 'Sea view', 'Air conditioning', 'TV'],
      lat: 42.4531, lng: 18.5322,
      cancellationPolicy: 'moderate',
      bookingMode: 'request_to_book',
      avgRating: 4.8, reviewCount: 9,
      ownerId: marko._id,
    },
  ]);

  console.log(`🏠 Created ${listings.length} listings`);

  // Shorthand refs
  const [kotorApt, perastStudio, budvaVilla, tivatSuite, ulcinjGuest, hercegApt] = listings;

  // ── House rules ───────────────────────────────────────────────────────────
  await HouseRule.insertMany([
    {
      listingId: kotorApt._id, hostId: ana._id,
      rules: [
        { ruleId: 'r1', category: 'smoking', title: 'No smoking', description: 'Strictly no smoking inside the apartment.', required: true },
        { ruleId: 'r2', category: 'noise', title: 'Quiet hours 10pm–8am', description: 'Please respect the neighbours.', required: true },
        { ruleId: 'r3', category: 'pets', title: 'No pets', required: false },
        { ruleId: 'r4', category: 'check-in', title: 'Check-in after 3pm', required: false },
      ],
    },
    {
      listingId: budvaVilla._id, hostId: marko._id,
      rules: [
        { ruleId: 'r1', category: 'smoking', title: 'Outdoor smoking only', required: false },
        { ruleId: 'r2', category: 'guests', title: 'No unregistered overnight guests', required: true },
        { ruleId: 'r3', category: 'noise', title: 'Pool closes at 11pm', required: true },
        { ruleId: 'r4', category: 'parking', title: 'Use designated parking spaces', required: false },
      ],
    },
  ]);

  // ── Check-in instructions ─────────────────────────────────────────────────
  await CheckinInstruction.insertMany([
    {
      listingId: kotorApt._id, hostId: ana._id,
      accessCode: '4821#',
      wifiNetwork: 'KotorOldTown_Guest', wifiPassword: 'adriatic2024',
      checkInTime: '3:00 PM', checkOutTime: '11:00 AM',
      directions: 'Enter through the main gate of the Old Town (the Sea Gate). Walk straight for 100m, turn right at the clock tower, we are the blue door on the left — #14. I\'ll leave the keys in the lockbox.',
      parkingInfo: 'Parking available at Stari Grad car park, 5 min walk. Approx €8/day.',
      emergencyContact: '+382 67 123 456 (Ana)',
      additionalNotes: 'Please take off shoes at the entrance. Rubbish bins are in the courtyard. Let me know if you need restaurant recommendations!',
      revealHoursBeforeCheckin: 48,
    },
    {
      listingId: budvaVilla._id, hostId: marko._id,
      accessCode: '7743*',
      wifiNetwork: 'BudvaVilla_WiFi', wifiPassword: 'summermontenegro',
      checkInTime: '2:00 PM', checkOutTime: '10:00 AM',
      directions: 'From the Budva bypass road, take the exit for Bečići. Follow signs for Mediteran Resort, we are 200m past it on the left. Gate code is 7743*.',
      parkingInfo: 'Private parking for 2 cars inside the gate.',
      emergencyContact: '+382 69 987 654 (Marko)',
      additionalNotes: 'Pool towels in the chest by the back door. BBQ charcoal in the shed. Please leave the pool clean when you depart.',
      revealHoursBeforeCheckin: 24,
    },
  ]);

  // ── Bookings + Reviews + Payouts ──────────────────────────────────────────
  const bookingsData = [
    // Past confirmed bookings (Sofia stayed at these)
    { listing: kotorApt,    ci: past(45), co: past(42), guests: 2, paid: true,   review: { rating: 5, comment: 'Incredible location inside the old town walls. Ana was so helpful and the views were breathtaking. Will definitely return!' } },
    { listing: perastStudio, ci: past(90), co: past(88), guests: 2, paid: true,  review: { rating: 5, comment: 'The most romantic place I\'ve ever stayed. Waking up to the sound of the sea with a view of the Bay of Kotor was magical.' } },
    { listing: tivatSuite,  ci: past(30), co: past(28), guests: 2, paid: true,   review: { rating: 4, comment: 'Great location in Porto Montenegro. Very clean and modern. A bit noisy from the marina at night but otherwise excellent.' } },
    { listing: ulcinjGuest,  ci: past(120), co: past(116), guests: 3, paid: true, review: { rating: 5, comment: 'Brilliant value. Ana was a fantastic host and the old town location is perfect. Long Beach is unbelievable.' } },
    // Upcoming bookings
    { listing: budvaVilla,  ci: future(14), co: future(21), guests: 4, paid: true,  review: null },
    { listing: hercegApt,   ci: future(30), co: future(33), guests: 2, paid: false, review: null },
    // Another guest's past booking (for reviews)
    { listing: kotorApt,    ci: past(200), co: past(196), guests: 3, paid: true,   review: { rating: 5, comment: 'Ana\'s apartment is a gem. Perfect for exploring Kotor. We\'ll be back next summer!' }, useAdmin: true },
    { listing: budvaVilla,  ci: past(60),  co: past(54),  guests: 6, paid: true,   review: { rating: 5, comment: 'Amazing villa, fantastic pool. The best family holiday we\'ve had. Marko was very responsive and helpful.' }, useAdmin: true },
  ];

  let bookingCount = 0, reviewCount = 0, payoutCount = 0;

  for (const bd of bookingsData) {
    const userId = bd.useAdmin ? admin._id : guest._id;
    const nights = Math.round((bd.co - bd.ci) / 86400000);
    const total  = bd.listing.price * nights;

    const bk = await Booking.create({
      listingId: bd.listing._id,
      userId,
      checkIn:    bd.ci,
      checkOut:   bd.co,
      guests:     bd.guests,
      nights,
      totalPrice: total,
      status:     bd.paid ? 'confirmed' : 'pending',
      paid:       bd.paid,
      guestReviewedListing: !!bd.review,
    });
    bookingCount++;

    // Payout for confirmed bookings
    if (bd.paid) {
      const fee      = Math.round(total * 0.05 * 100) / 100;
      const earnings = Math.round((total - fee) * 100) / 100;
      const d2       = bd.ci;
      await Payout.create({
        hostId:      bd.listing.ownerId,
        bookingId:   bk._id,
        listingId:   bd.listing._id,
        grossAmount: total,
        platformFee: fee,
        hostEarnings: earnings,
        currency: 'EUR',
        status:   bd.ci < new Date() ? 'paid' : 'pending',
        periodYear:  d2.getFullYear(),
        periodMonth: d2.getMonth() + 1,
        paidAt:   bd.ci < past(7) ? past(Math.floor(Math.random() * 5 + 1)) : null,
      });
      payoutCount++;
    }

    // Review
    if (bd.review) {
      try {
        await Review.create({
          listingId: bd.listing._id,
          userId,
          rating:  bd.review.rating,
          comment: bd.review.comment,
          title:   '',
        });
        reviewCount++;
      } catch (e) {
        if (e.code !== 11000) console.warn('Review skip:', e.message);
      }
    }
  }

  // ── Update superhost stats for Ana ────────────────────────────────────────
  await User.findByIdAndUpdate(ana._id, {
    isSuperhost: true,
    superhostSince: past(180),
    superhostStats: {
      avgRating:        4.9,
      totalBookings:    24,
      responseRate:     100,
      cancellationRate: 0,
      lastCalculated:   new Date(),
    },
  });

  // ── Welcome notifications ─────────────────────────────────────────────────
  await Notification.insertMany([
    {
      userId: guest._id,
      type: 'booking_confirmed', icon: '🎉', priority: 'high',
      title: 'Booking Confirmed — Budva Beach Villa',
      message: 'Your 7-night stay at Modern Beach Villa, Budva is confirmed. Check-in: ' + future(14).toLocaleDateString('en-GB'),
      actionUrl: '/mybookings.html', actionText: 'View Booking',
      isRead: false,
    },
    {
      userId: ana._id,
      type: 'booking_request', icon: '🏠', priority: 'high',
      title: 'New booking — Sea View Apartment',
      message: 'You have a new upcoming booking for 3 nights.',
      actionUrl: '/host.html', actionText: 'View',
      isRead: false,
    },
    {
      userId: ana._id,
      type: 'superhost_achieved', icon: '🏆', priority: 'high',
      title: "You're a Superhost! 🏆",
      message: 'Congratulations! Your outstanding reviews, response rate, and hosting history have earned you Superhost status.',
      actionUrl: '/host-profile.html?id=' + ana._id, actionText: 'View Badge',
      isRead: true,
    },
  ]);

  // ── Favorites ─────────────────────────────────────────────────────────────
  await Favorite.insertMany([
    { userId: guest._id, listingId: kotorApt._id },
    { userId: guest._id, listingId: perastStudio._id },
    { userId: guest._id, listingId: budvaVilla._id },
  ]);

  console.log(`📅 Created ${bookingCount} bookings`);
  console.log(`⭐ Created ${reviewCount} reviews`);
  console.log(`💰 Created ${payoutCount} payout records`);
  console.log(`🔔 Created notifications + favorites`);
  console.log('');
  console.log('════════════════════════════════════════════');
  console.log('  DEMO ACCOUNTS (password: demo1234)');
  console.log('────────────────────────────────────────────');
  console.log('  Guest:  guest@demo.com');
  console.log('  Host 1: ana@demo.com   (Superhost 🏆)');
  console.log('  Host 2: marko@demo.com');
  console.log('  Admin:  admin@demo.com');
  console.log('════════════════════════════════════════════');

  await mongoose.disconnect();
  console.log('\n✅ Seed complete!');
}

// Run directly or export for testing
if (require.main === module) {
  seed().then(() => process.exit(0)).catch(err => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  });
} else {
  module.exports = { seed };
}
