require('dotenv').config();
const express    = require('express');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const passport   = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session    = require('express-session');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const nodemailer = require('nodemailer');

const app = express();

// Trust Railway/Render/Heroku proxy (required for rate limiting + secure cookies behind load balancer)
app.set('trust proxy', 1);

// ─── Security ─────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // disabled so Leaflet CDN loads fine
  crossOriginEmbedderPolicy: false,
}));

// ─── Config ───────────────────────────────────────────────────────────────────
const MONGO_URL        = process.env.MONGO_URL        || 'mongodb://127.0.0.1:27017/staymontenegro';
const JWT_SECRET       = process.env.JWT_SECRET       || 'staymontenegro-dev-secret';
const PORT             = process.env.PORT             || 3000;
const STRIPE_KEY       = process.env.STRIPE_KEY       || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_SECRET    = process.env.GOOGLE_SECRET    || '';
const BASE_URL         = process.env.BASE_URL         || `http://localhost:${PORT}`;
const COUNTRY          = process.env.COUNTRY          || 'Montenegro';

// Stripe optional
let stripe = null;
if (STRIPE_KEY) stripe = require('stripe')(STRIPE_KEY);

// Cloudinary optional
let cloudinary = null;
if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

// ─── Stripe webhook (MUST be before express.json so we get the raw body) ───────
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).end();
  let event;
  try {
    if (STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.warn('⚠️  Stripe webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    try { await confirmBookingFromCheckout(s); }
    catch (e) { console.error('Webhook booking confirm failed:', e.message); }
  }
  res.json({ received: true });
});

// Normal body parsing for everything else
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// ─── Email (optional) ─────────────────────────────────────────────────────────
let mailer = null;
if (process.env.EMAIL_HOST && process.env.EMAIL_USER) {
  mailer = nodemailer.createTransport({
    host:   process.env.EMAIL_HOST,
    port:   Number(process.env.EMAIL_PORT) || 587,
    secure: process.env.EMAIL_SECURE === 'true',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
  mailer.verify().then(() => console.log('✅ Email ready')).catch(e => console.warn('⚠️  Email not available:', e.message));
}

async function sendMail({ to, subject, html }) {
  if (!mailer) return;
  try {
    await mailer.sendMail({
      from: `"Stay${COUNTRY}" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
      to, subject, html,
    });
  } catch (e) {
    console.warn('Email send failed:', e.message);
  }
}

function bookingConfirmationEmail(userEmail, listing, booking) {
  return {
    to: userEmail,
    subject: `Booking confirmed — ${listing.title}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#fff;">
        <h1 style="color:#ff385c;font-size:28px;margin-bottom:4px;">Stay${COUNTRY}</h1>
        <h2 style="font-weight:700;margin-bottom:20px;">Your booking is confirmed! 🎉</h2>
        <div style="background:#f7f7f7;border-radius:12px;padding:20px;margin-bottom:20px;">
          <h3 style="margin:0 0 12px;">${listing.title}</h3>
          <p style="margin:4px 0;color:#555;">📍 ${listing.city}</p>
          <p style="margin:4px 0;color:#555;">📅 Check-in: <strong>${new Date(booking.checkIn).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' })}</strong></p>
          <p style="margin:4px 0;color:#555;">📅 Check-out: <strong>${new Date(booking.checkOut).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' })}</strong></p>
          <p style="margin:4px 0;color:#555;">👥 Guests: <strong>${booking.guests || 1}</strong></p>
          <p style="margin:12px 0 0;font-size:18px;font-weight:700;">Total: €${booking.totalPrice}</p>
        </div>
        <p style="color:#777;font-size:13px;">Thank you for booking with Stay${COUNTRY}. Have a wonderful stay!</p>
      </div>`,
  };
}

function welcomeEmail(userEmail) {
  return {
    to: userEmail,
    subject: `Welcome to Stay${COUNTRY} 🎉`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#fff;">
        <h1 style="color:#ff385c;font-size:28px;margin-bottom:4px;">Stay${COUNTRY}</h1>
        <h2>Welcome aboard! 👋</h2>
        <p style="color:#555;line-height:1.6;">Thanks for joining Stay${COUNTRY}. You can now browse and book amazing properties.</p>
        <a href="${BASE_URL}" style="display:inline-block;margin-top:20px;background:#ff385c;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;">Browse Listings</a>
      </div>`,
  };
}

function emailVerificationEmail(userEmail, verificationLink) {
  return {
    to: userEmail,
    subject: `Verify your email — Stay${COUNTRY}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#fff;">
        <h1 style="color:#ff385c;font-size:28px;margin-bottom:4px;">Stay${COUNTRY}</h1>
        <h2>Verify your email address ✉️</h2>
        <p style="color:#555;line-height:1.6;">Thank you for signing up! Please verify your email address to get access to all features.</p>
        <a href="${verificationLink}" style="display:inline-block;margin-top:20px;background:#ff385c;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;">Verify Email</a>
        <p style="color:#999;font-size:13px;margin-top:20px;">This link expires in 24 hours. If you didn't sign up, please ignore this email.</p>
      </div>`,
  };
}

function messageEmail(toEmail, fromName, listing, body) {
  return {
    to: toEmail,
    subject: `New message about ${listing.title}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#fff;">
        <h1 style="color:#ff385c;font-size:24px;margin-bottom:4px;">Stay${COUNTRY}</h1>
        <h2 style="font-weight:700;">New message from ${fromName}</h2>
        <p style="color:#555;">Regarding <strong>${listing.title}</strong> in ${listing.city}:</p>
        <blockquote style="border-left:3px solid #ff385c;margin:16px 0;padding:8px 16px;color:#444;background:#faf0f2;">${body}</blockquote>
        <a href="${BASE_URL}/messages.html" style="display:inline-block;margin-top:10px;background:#ff385c;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;">Reply</a>
      </div>`,
  };
}

function cancellationEmail(userEmail, listing, booking, refundAmount) {
  return {
    to: userEmail,
    subject: `Booking cancelled — ${listing.title}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#fff;">
        <h1 style="color:#ff385c;font-size:28px;margin-bottom:4px;">Stay${COUNTRY}</h1>
        <h2>Booking Cancelled</h2>
        <div style="background:#f7f7f7;border-radius:12px;padding:20px;margin-bottom:20px;">
          <h3 style="margin:0 0 12px;">${listing.title}</h3>
          <p style="margin:4px 0;color:#555;">📅 Was: ${new Date(booking.checkIn).toLocaleDateString('en-GB')} → ${new Date(booking.checkOut).toLocaleDateString('en-GB')}</p>
          ${refundAmount > 0 ? `<p style="margin:12px 0 0;font-size:16px;font-weight:700;color:#00a86b;">Refund: €${refundAmount}</p>` : '<p style="color:#999;margin-top:12px;">No refund applicable per cancellation policy.</p>'}
        </div>
        <a href="${BASE_URL}" style="display:inline-block;background:#ff385c;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;">Browse Other Listings</a>
      </div>`,
  };
}

// ─── MongoDB ──────────────────────────────────────────────────────────────────
if (require.main === module && process.env.NODE_ENV !== 'test') {
  mongoose.connect(MONGO_URL)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB error:', err.message));
}

// ─── Schemas ──────────────────────────────────────────────────────────────────
const AMENITIES_LIST = [
  'WiFi', 'Parking', 'Pool', 'Air conditioning', 'Kitchen',
  'Washing machine', 'Pets allowed', 'Sea view', 'Balcony', 'TV',
];

const CANCELLATION_POLICIES = ['flexible', 'moderate', 'strict'];
const BOOKING_MODES = ['instant_book', 'request_to_book'];

const UserSchema = new mongoose.Schema({
  email:       { type: String, required: true, unique: true, lowercase: true },
  password:    { type: String },
  isAdmin:     { type: Boolean, default: false },
  googleId:    { type: String },
  displayName: { type: String },
  avatar:      { type: String },
  bio:         { type: String, default: '' },          // v18: host profile bio
  location:    { type: String, default: '' },          // v18: host location
  // v17: email verification
  isEmailVerified:          { type: Boolean, default: false },
  verificationToken:        { type: String },
  verificationTokenExpires: { type: Date },
  // v18: superhost
  isSuperhost:              { type: Boolean, default: false },
  superhostSince:           { type: Date },
  superhostStats: {
    avgRating:        { type: Number, default: 0 },
    totalBookings:    { type: Number, default: 0 },
    responseRate:     { type: Number, default: 0 },   // 0–100 %
    cancellationRate: { type: Number, default: 0 },   // 0–100 %
    lastCalculated:   { type: Date },
  },
}, { timestamps: true });

const ListingSchema = new mongoose.Schema({
  title:       { type: String, required: true },
  city:        { type: String, required: true },
  description: { type: String, default: '' },
  image:       { type: String, default: '' },              // primary image (= images[0])
  images:      { type: [String], default: [] },            // gallery
  price:       { type: Number, required: true, min: 0 },   // base nightly price
  maxGuests:   { type: Number, default: 4, min: 1 },       // guest cap
  amenities:   { type: [String], default: [] },
  lat:         { type: Number },                           // geo
  lng:         { type: Number },
  // Seasonal / dynamic pricing: each rule overrides the base price
  pricingRules: {
    type: [{
      label: { type: String, default: '' },
      start: { type: Date, required: true },
      end:   { type: Date, required: true },
      price: { type: Number, required: true, min: 0 },
    }],
    default: [],
  },
  // v17: cancellation policy
  cancellationPolicy:            { type: String, enum: CANCELLATION_POLICIES, default: 'moderate' },
  cancellationPolicyDescription: { type: String, default: '' },
  // v18: instant book
  bookingMode: { type: String, enum: BOOKING_MODES, default: 'request_to_book' },
  ownerId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  avgRating:   { type: Number, default: 0 },
  reviewCount: { type: Number, default: 0 },
}, { timestamps: true });

const BookingSchema = new mongoose.Schema({
  listingId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', required: true },
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true },
  checkIn:    { type: Date, required: true },
  checkOut:   { type: Date, required: true },
  guests:     { type: Number, default: 1, min: 1 },
  totalPrice: { type: Number },
  nights:     { type: Number },
  status:     { type: String, enum: ['pending', 'confirmed', 'cancelled'], default: 'pending' },
  paid:       { type: Boolean, default: false },
  // v18: review tracking
  guestReviewedListing: { type: Boolean, default: false }, // guest reviewed the listing
  hostReviewedGuest:    { type: Boolean, default: false }, // host reviewed the guest
}, { timestamps: true });

// v17: Enhanced review schema with title, helpful votes, host response, soft delete
const ReviewSchema = new mongoose.Schema({
  listingId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', required: true },
  userId:             { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true },
  rating:             { type: Number, required: true, min: 1, max: 5 },
  comment:            { type: String, default: '' },
  // Enhanced fields
  title:              { type: String, default: '', maxlength: 100 },
  helpfulVotes:       [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  hostResponse:       { type: String, default: '', maxlength: 1000 },
  hostResponseAt:     { type: Date },
  isDeleted:          { type: Boolean, default: false },
}, { timestamps: true });
ReviewSchema.index({ listingId: 1, userId: 1 }, { unique: true });
ReviewSchema.index({ listingId: 1, createdAt: -1 });

// v18: Host reviews a guest (keyed by booking so one review per stay)
const GuestReviewSchema = new mongoose.Schema({
  bookingId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Booking',  required: true, unique: true },
  listingId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Listing',  required: true },
  guestId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true },
  hostId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true },
  rating:         { type: Number, required: true, min: 1, max: 5 },
  comment:        { type: String, default: '', maxlength: 1000 },
  // sub-ratings (optional)
  cleanliness:    { type: Number, min: 1, max: 5 },
  communication:  { type: Number, min: 1, max: 5 },
  houseRules:     { type: Number, min: 1, max: 5 },
  isDeleted:      { type: Boolean, default: false },
}, { timestamps: true });
GuestReviewSchema.index({ guestId: 1, createdAt: -1 });
GuestReviewSchema.index({ hostId: 1, createdAt: -1 });

// Favorites / Wishlist
const FavoriteSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true },
  listingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', required: true },
}, { timestamps: true });
FavoriteSchema.index({ userId: 1, listingId: 1 }, { unique: true });

// Messaging
const MessageSchema = new mongoose.Schema({
  listingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', required: true },
  fromId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true },
  toId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true },
  body:      { type: String, required: true },
  read:      { type: Boolean, default: false },
}, { timestamps: true });
MessageSchema.index({ listingId: 1, fromId: 1, toId: 1 });

// v17: Notifications
const NotificationSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type:       { type: String, required: true, index: true },
  title:      { type: String, required: true, maxlength: 200 },
  message:    { type: String, required: true, maxlength: 1000 },
  icon:       { type: String, default: '📌' },
  data:       { type: mongoose.Schema.Types.Mixed, default: {} },
  actionUrl:  { type: String, default: null },
  actionText: { type: String, default: 'View', maxlength: 100 },
  isRead:     { type: Boolean, default: false, index: true },
  isArchived: { type: Boolean, default: false },
  priority:   { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
}, { timestamps: true });
NotificationSchema.index({ userId: 1, isRead: 1 });

// v17: House Rules
const HouseRuleSchema = new mongoose.Schema({
  listingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', required: true, unique: true },
  hostId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true },
  rules: [{
    ruleId:      { type: String, required: true },
    category:    { type: String, enum: ['pets','smoking','noise','guests','parking','check-in','check-out','kitchen','general'], required: true },
    title:       { type: String, required: true, maxlength: 100 },
    description: { type: String, maxlength: 500 },
    required:    { type: Boolean, default: false },
  }],
}, { timestamps: true });

// v17: Rule acknowledgments
const RuleAcknowledgmentSchema = new mongoose.Schema({
  bookingId:             { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', required: true, unique: true },
  guestId:               { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true },
  listingId:             { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', required: true },
  acknowledgedRules:     [{ ruleId: String, title: String, acknowledgedAt: Date }],
  allRulesAcknowledged:  { type: Boolean, default: false },
  acknowledgedAt:        { type: Date },
}, { timestamps: true });

// v17: Cancellation records
const CancellationSchema = new mongoose.Schema({
  bookingId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', required: true },
  requestedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true },
  role:         { type: String, enum: ['guest', 'host', 'admin'], required: true },
  reason:       { type: String, default: '' },
  policy:       { type: String, enum: CANCELLATION_POLICIES, required: true },
  totalPrice:   { type: Number, required: true },
  daysBeforeCheckIn: { type: Number, required: true },
  refundAmount: { type: Number, default: 0 },
  refundPct:    { type: Number, default: 0 },
  status:       { type: String, enum: ['pending','approved','rejected'], default: 'pending' },
  processedAt:  { type: Date },
  stripeRefundId: { type: String },
}, { timestamps: true });

// v19: Check-in Instructions (private, only visible to confirmed guests)
const CheckinInstructionSchema = new mongoose.Schema({
  listingId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', required: true, unique: true },
  hostId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true },
  // Structured sections
  accessCode:       { type: String, default: '' },   // door code / key lockbox
  wifiNetwork:      { type: String, default: '' },
  wifiPassword:     { type: String, default: '' },
  checkInTime:      { type: String, default: '' },   // e.g. "3:00 PM"
  checkOutTime:     { type: String, default: '' },
  parkingInfo:      { type: String, default: '' },
  directions:       { type: String, default: '' },
  emergencyContact: { type: String, default: '' },
  additionalNotes:  { type: String, default: '' },
  // When to reveal instructions to guest
  revealHoursBeforeCheckin: { type: Number, default: 24 }, // default: 24h before
}, { timestamps: true });

// v19: Payout records (host earnings per confirmed booking)
const PayoutSchema = new mongoose.Schema({
  hostId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true, index: true },
  bookingId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', required: true, unique: true },
  listingId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', required: true },
  grossAmount:    { type: Number, required: true },  // booking total
  platformFee:    { type: Number, required: true },  // 5% platform fee
  hostEarnings:   { type: Number, required: true },  // grossAmount - platformFee
  currency:       { type: String, default: 'EUR' },
  status:         { type: String, enum: ['pending','paid','cancelled'], default: 'pending' },
  periodYear:     { type: Number, required: true },
  periodMonth:    { type: Number, required: true },  // 1–12
  paidAt:         { type: Date },
}, { timestamps: true });
PayoutSchema.index({ hostId: 1, periodYear: 1, periodMonth: 1 });

const User             = mongoose.model('User',             UserSchema);
const Listing          = mongoose.model('Listing',          ListingSchema);
const Booking          = mongoose.model('Booking',          BookingSchema);
const Review           = mongoose.model('Review',           ReviewSchema);
const GuestReview      = mongoose.model('GuestReview',      GuestReviewSchema);
const Favorite         = mongoose.model('Favorite',         FavoriteSchema);
const Message          = mongoose.model('Message',          MessageSchema);
const Notification     = mongoose.model('Notification',     NotificationSchema);
const HouseRule        = mongoose.model('HouseRule',        HouseRuleSchema);
const RuleAcknowledgment = mongoose.model('RuleAcknowledgment', RuleAcknowledgmentSchema);
const Cancellation     = mongoose.model('Cancellation',     CancellationSchema);
const CheckinInstruction = mongoose.model('CheckinInstruction', CheckinInstructionSchema);
const Payout           = mongoose.model('Payout',           PayoutSchema);

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const authLimiter    = rateLimit({ windowMs: 15*60*1000, max: 20,  message: { error: 'Too many attempts. Please wait 15 minutes.' }, standardHeaders: true, legacyHeaders: false });
const uploadLimiter  = rateLimit({ windowMs: 60*1000,    max: 30,  message: { error: 'Too many uploads. Slow down.' } });
// Note: general API rate limiter disabled — Railway proxy causes false positives
// const generalLimiter = rateLimit({ windowMs: 60*1000, max: 200, message: { error: 'Too many requests.' } });
// app.use('/api/', generalLimiter);

// ─── Auth Middleware ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function optionalAuth(req, res, next) {
  const token = req.headers['authorization'];
  if (token) { try { req.user = jwt.verify(token, JWT_SECRET); } catch {} }
  next();
}

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, async () => {
    const user = await User.findById(req.user.id);
    if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sanitise(str) {
  if (!str) return '';
  return String(str).replace(/<[^>]*>/g, '').trim().slice(0, 2000);
}

// ─── Seasonal / dynamic pricing engine ───────────────────────────────────────
function dayStart(d) {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}

function sanitisePricingRules(rules) {
  if (!Array.isArray(rules)) return [];
  const clean = [];
  for (const r of rules.slice(0, 50)) {
    const start = new Date(r.start), end = new Date(r.end), price = Number(r.price);
    if (isNaN(start) || isNaN(end) || isNaN(price) || price < 0) continue;
    if (end <= start) continue;
    clean.push({ label: sanitise(r.label).slice(0, 60), start: dayStart(start), end: dayStart(end), price });
  }
  return clean;
}

function priceForNight(listing, nightDate) {
  const t = dayStart(nightDate).getTime();
  for (const r of (listing.pricingRules || [])) {
    const s = dayStart(r.start).getTime(), e = dayStart(r.end).getTime();
    if (t >= s && t < e) return { price: r.price, label: r.label || 'Seasonal' };
  }
  return { price: listing.price, label: 'Base' };
}

function quotePrice(listing, checkIn, checkOut) {
  const ci = dayStart(checkIn), co = dayStart(checkOut);
  const nights = Math.round((co - ci) / 86400000);
  if (nights <= 0) return { nights: 0, total: 0, breakdown: [], avgNightly: listing.price };

  const perNight = [];
  for (let i = 0; i < nights; i++) {
    const night = new Date(ci.getTime() + i * 86400000);
    perNight.push({ date: night, ...priceForNight(listing, night) });
  }

  const breakdown = [];
  for (const n of perNight) {
    const last = breakdown[breakdown.length - 1];
    if (last && last.price === n.price && last.label === n.label) {
      last.nights++; last.subtotal += n.price;
    } else {
      breakdown.push({ label: n.label, price: n.price, nights: 1, subtotal: n.price });
    }
  }
  const total = perNight.reduce((s, n) => s + n.price, 0);
  return { nights, total, breakdown, avgNightly: Math.round((total / nights) * 100) / 100 };
}

// ─── Cancellation policy helpers ─────────────────────────────────────────────
function calcRefund(policy, daysBeforeCheckIn, totalPrice) {
  let pct = 0;
  if (policy === 'flexible')  pct = daysBeforeCheckIn >= 7  ? 100 : 0;
  if (policy === 'moderate')  pct = daysBeforeCheckIn >= 14 ? 50  : 0;
  if (policy === 'strict')    pct = daysBeforeCheckIn >= 30 ? 50  : 0;
  const gross = (totalPrice * pct) / 100;
  const fee   = gross * 0.05; // 5% platform fee
  return {
    refundPct:    pct,
    refundAmount: Math.round((gross - fee) * 100) / 100,
    platformFee:  Math.round(fee * 100) / 100,
  };
}

function policyDescription(policy) {
  return {
    flexible: 'Free cancellation up to 7 days before check-in. Full refund.',
    moderate: '50% refund if cancelled 14+ days before check-in. No refund within 14 days.',
    strict:   '50% refund if cancelled 30+ days before check-in. Non-refundable within 30 days.',
  }[policy] || '';
}

// ─── Notification helper ──────────────────────────────────────────────────────
// Notification types that should also send an email (high-signal events only)
const EMAIL_NOTIFY_TYPES = new Set([
  'booking_confirmed', 'booking_request', 'booking_cancelled',
  'cancellation_approved', 'cancellation_denied', 'cancellation_request',
  'new_message',
  'review_left', 'host_reply_review',
  'superhost_achieved', 'superhost_lost',
  'account_verified',
  'payment_received', 'refund_issued',
]);

async function notify(userId, { type, title, message, icon = '📌', data = {}, actionUrl = null, actionText = 'View', priority = 'medium' }) {
  try {
    await Notification.create({ userId, type, title, message, icon, data, actionUrl, actionText, priority });

    // Mirror high-signal notifications to email (if mailer is configured)
    if (mailer && EMAIL_NOTIFY_TYPES.has(type)) {
      const user = await User.findById(userId, 'email displayName');
      if (user?.email) {
        const ctaHtml = actionUrl
          ? `<a href="${BASE_URL}${actionUrl}" style="display:inline-block;margin-top:16px;background:#ff385c;color:white;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:700;">${actionText}</a>`
          : '';
        sendMail({
          to: user.email,
          subject: title,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#fff;">
              <h1 style="color:#ff385c;font-size:24px;margin-bottom:4px;">Stay${COUNTRY}</h1>
              <h2 style="font-size:18px;margin-bottom:8px;">${icon} ${title}</h2>
              <p style="color:#555;line-height:1.6;">${message}</p>
              ${ctaHtml}
              <p style="color:#bbb;font-size:12px;margin-top:24px;">You're receiving this because you have an account on Stay${COUNTRY}.</p>
            </div>`,
        });
      }
    }
  } catch (e) {
    console.warn('Notify failed:', e.message);
  }
}

// ─── Geocoding ────────────────────────────────────────────────────────────────
async function geocodeCity(city) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city + ', ' + COUNTRY)}&format=json&limit=1`;
    const r = await fetch(url, { headers: { 'User-Agent': `Stay${COUNTRY}/3.0` } });
    const data = await r.json();
    if (data && data.length) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch (e) { console.warn('Geocode failed:', e.message); }
  return { lat: undefined, lng: undefined };
}

// ─── Multer ───────────────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e5)}${ext}`);
  },
});
const fileFilter = (req, file, cb) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  allowed.includes(path.extname(file.originalname).toLowerCase()) ? cb(null, true) : cb(new Error('Images only'));
};
const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

async function persistUpload(file) {
  if (cloudinary) {
    const result = await cloudinary.uploader.upload(file.path, {
      folder: 'staymontenegro',
      transformation: [{ width: 1200, height: 800, crop: 'fill', quality: 'auto' }],
    });
    fs.unlinkSync(file.path);
    return result.secure_url;
  }
  return `/uploads/${file.filename}`;
}

// ─── Image Upload (single) ────────────────────────────────────────────────────
app.post('/api/upload', authMiddleware, uploadLimiter, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ url: await persistUpload(req.file) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// ─── Image Upload (multiple — gallery) ───────────────────────────────────────
app.post('/api/upload-multiple', authMiddleware, uploadLimiter, upload.array('images', 10), async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files uploaded' });
    const urls = [];
    for (const f of req.files) urls.push(await persistUpload(f));
    res.json({ urls });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// ─── Google OAuth ─────────────────────────────────────────────────────────────
if (GOOGLE_CLIENT_ID && GOOGLE_SECRET) {
  app.use(session({ secret: JWT_SECRET, resave: false, saveUninitialized: false }));
  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_SECRET,
    callbackURL: `${BASE_URL}/auth/google/callback`,
  }, async (at, rt, profile, done) => {
    try {
      const email = profile.emails[0].value;
      let user = await User.findOne({ email });
      if (!user) {
        user = await User.create({ email, googleId: profile.id, displayName: profile.displayName, avatar: profile.photos?.[0]?.value || '', isEmailVerified: true });
        sendMail(welcomeEmail(email));
      } else if (!user.googleId) {
        user.googleId = profile.id; user.displayName = profile.displayName;
        user.avatar = profile.photos?.[0]?.value || '';
        user.isEmailVerified = true;
        await user.save();
      }
      done(null, user);
    } catch (err) { done(err); }
  }));

  passport.serializeUser((user, done)       => done(null, user._id));
  passport.deserializeUser(async (id, done) => done(null, await User.findById(id)));

  app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
  app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/auth.html?error=google' }),
    (req, res) => {
      const token = jwt.sign({ id: req.user._id, email: req.user.email, isAdmin: req.user.isAdmin }, JWT_SECRET, { expiresIn: '7d' });
      res.redirect(`/auth-callback.html?token=${token}&email=${encodeURIComponent(req.user.email)}`);
    }
  );
} else {
  app.get('/auth/google', (req, res) => res.redirect('/auth.html?error=google_not_configured'));
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6)  return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 10);
    const verificationToken   = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const tokenExpires        = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const user = await User.create({ email, password: hashed, verificationToken, verificationTokenExpires: tokenExpires });
    const token = jwt.sign({ id: user._id, email: user.email, isAdmin: user.isAdmin }, JWT_SECRET, { expiresIn: '7d' });

    sendMail(welcomeEmail(email));
    if (mailer) {
      const verificationLink = `${BASE_URL}/verify-email.html?token=${verificationToken}`;
      sendMail(emailVerificationEmail(email, verificationLink));
    }
    res.json({ message: 'Registered ✅', token });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Registration failed' }); }
});

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() });
    if (!user)          return res.status(400).json({ error: 'User not found' });
    if (!user.password) return res.status(400).json({ error: 'This account uses Google Sign-In' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Wrong password' });

    const token = jwt.sign({ id: user._id, email: user.email, isAdmin: user.isAdmin }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Logged in ✅', token, isAdmin: user.isAdmin, isEmailVerified: user.isEmailVerified });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Login failed' }); }
});

// Who am I
app.get('/api/me', authMiddleware, async (req, res) => {
  const user = await User.findById(req.user.id, '-password');
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

// ─── Email Verification ───────────────────────────────────────────────────────
app.post('/api/verify-email', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Verification token required' });
    const user = await User.findOne({ verificationToken: token, verificationTokenExpires: { $gt: new Date() } });
    if (!user) return res.status(400).json({ error: 'Invalid or expired verification token' });
    user.isEmailVerified = true;
    user.verificationToken = undefined;
    user.verificationTokenExpires = undefined;
    await user.save();
    await notify(user._id, { type: 'account_verified', title: 'Email Verified ✅', message: 'Your email has been verified. Welcome!', icon: '✅', actionUrl: '/', actionText: 'Browse Listings' });
    res.json({ message: 'Email verified successfully! ✅' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Verification failed' }); }
});

app.post('/api/resend-verification', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isEmailVerified) return res.status(400).json({ error: 'Email already verified' });
    const verificationToken = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    user.verificationToken = verificationToken;
    user.verificationTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await user.save();
    const verificationLink = `${BASE_URL}/verify-email.html?token=${verificationToken}`;
    sendMail(emailVerificationEmail(user.email, verificationLink));
    res.json({ message: 'Verification email sent!' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to resend verification' }); }
});

// ─── Listings Routes ──────────────────────────────────────────────────────────
app.get('/api/listings', async (req, res) => {
  try {
    const { city, minPrice, maxPrice, amenities, guests, checkIn, checkOut } = req.query;
    const filter = {};
    if (city)      filter.city  = { $regex: city, $options: 'i' };
    if (minPrice)  filter.price = { ...filter.price, $gte: Number(minPrice) };
    if (maxPrice)  filter.price = { ...filter.price, $lte: Number(maxPrice) };
    if (guests)    filter.maxGuests = { $gte: Number(guests) };
    if (amenities) {
      const list = amenities.split(',').map(a => a.trim()).filter(Boolean);
      if (list.length) filter.amenities = { $all: list };
    }

    let listings = await Listing.find(filter).sort({ createdAt: -1 }).lean();

    // Date-range search: drop booked listings, attach seasonal quote
    const ci = checkIn  ? new Date(checkIn)  : null;
    const co = checkOut ? new Date(checkOut) : null;
    if (ci && co && !isNaN(ci) && !isNaN(co) && co > ci) {
      const ids = listings.map(l => l._id);
      const conflicts = await Booking.find({
        listingId: { $in: ids },
        status: { $in: ['pending', 'confirmed'] },
        checkIn: { $lt: co }, checkOut: { $gt: ci },
      }, 'listingId');
      const booked = new Set(conflicts.map(b => b.listingId.toString()));
      listings = listings
        .filter(l => !booked.has(l._id.toString()))
        .map(l => ({ ...l, quote: quotePrice(l, ci, co) }));
    }

    res.json(listings);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load listings', detail: err.message, name: err.name }); }
});

app.get('/api/amenities', (req, res) => res.json(AMENITIES_LIST));

app.get('/api/listings/:id', async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    res.json(listing);
  } catch { res.status(500).json({ error: 'Failed to load listing' }); }
});

// Seasonal-aware price quote for a date range
app.get('/api/listings/:id/quote', async (req, res) => {
  try {
    const { checkIn, checkOut } = req.query;
    if (!checkIn || !checkOut) return res.status(400).json({ error: 'checkIn and checkOut required' });
    const ci = new Date(checkIn), co = new Date(checkOut);
    if (isNaN(ci) || isNaN(co) || co <= ci) return res.status(400).json({ error: 'Invalid date range' });
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    res.json(quotePrice(listing, ci, co));
  } catch { res.status(500).json({ error: 'Failed to quote price' }); }
});

app.post('/api/listings', authMiddleware, async (req, res) => {
  try {
    const { title, city, image, images, price, description, amenities, maxGuests, pricingRules, cancellationPolicy, bookingMode } = req.body;
    if (!title || !city || !price) return res.status(400).json({ error: 'title, city and price are required' });

    const gallery = Array.isArray(images) ? images.filter(Boolean).slice(0, 10) : [];
    const primary = image || gallery[0] || '';
    if (primary && !gallery.includes(primary)) gallery.unshift(primary);

    const { lat, lng } = await geocodeCity(sanitise(city));

    const listing = await Listing.create({
      title:       sanitise(title),
      city:        sanitise(city),
      description: sanitise(description),
      image:       primary,
      images:      gallery,
      price:       Number(price),
      maxGuests:   Math.max(1, Number(maxGuests) || 4),
      amenities:   Array.isArray(amenities) ? amenities.filter(a => AMENITIES_LIST.includes(a)) : [],
      pricingRules: sanitisePricingRules(pricingRules),
      cancellationPolicy: CANCELLATION_POLICIES.includes(cancellationPolicy) ? cancellationPolicy : 'moderate',
      bookingMode: BOOKING_MODES.includes(bookingMode) ? bookingMode : 'request_to_book',
      lat, lng,
      ownerId: req.user.id,
    });
    res.json({ message: 'Listing added ✅', listing });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to add listing' }); }
});

// Edit listing — owner or admin
app.patch('/api/listings/:id', authMiddleware, async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    const me = await User.findById(req.user.id);
    const isOwner = listing.ownerId && listing.ownerId.toString() === req.user.id;
    if (!isOwner && !me?.isAdmin) return res.status(403).json({ error: 'Not your listing' });

    const { title, city, description, price, maxGuests, amenities, image, images, pricingRules, cancellationPolicy, bookingMode } = req.body;
    if (title             !== undefined) listing.title       = sanitise(title);
    if (description       !== undefined) listing.description = sanitise(description);
    if (price             !== undefined) listing.price       = Number(price);
    if (maxGuests         !== undefined) listing.maxGuests   = Math.max(1, Number(maxGuests) || 1);
    if (amenities         !== undefined) listing.amenities   = Array.isArray(amenities) ? amenities.filter(a => AMENITIES_LIST.includes(a)) : listing.amenities;
    if (pricingRules      !== undefined) listing.pricingRules = sanitisePricingRules(pricingRules);
    if (cancellationPolicy !== undefined && CANCELLATION_POLICIES.includes(cancellationPolicy)) listing.cancellationPolicy = cancellationPolicy;
    if (bookingMode        !== undefined && BOOKING_MODES.includes(bookingMode))               listing.bookingMode        = bookingMode;
    if (Array.isArray(images))           listing.images      = images.filter(Boolean).slice(0, 10);
    if (image             !== undefined) listing.image       = image;
    if (!listing.image && listing.images.length) listing.image = listing.images[0];
    if (city !== undefined && sanitise(city) !== listing.city) {
      listing.city = sanitise(city);
      const geo = await geocodeCity(listing.city);
      listing.lat = geo.lat; listing.lng = geo.lng;
    }
    await listing.save();
    res.json({ message: 'Listing updated ✅', listing });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update listing' }); }
});

app.delete('/api/listings/:id', authMiddleware, async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    const me = await User.findById(req.user.id);
    const isOwner = listing.ownerId && listing.ownerId.toString() === req.user.id;
    if (!isOwner && !me?.isAdmin) return res.status(403).json({ error: 'Not allowed' });
    await Listing.findByIdAndDelete(req.params.id);
    await Booking.deleteMany({ listingId: req.params.id });
    await Favorite.deleteMany({ listingId: req.params.id });
    res.json({ message: 'Listing deleted' });
  } catch { res.status(500).json({ error: 'Failed to delete listing' }); }
});

// ─── Favorites / Wishlist ─────────────────────────────────────────────────────
app.get('/api/favorites', authMiddleware, async (req, res) => {
  try {
    const favs = await Favorite.find({ userId: req.user.id }).populate('listingId');
    res.json(favs.filter(f => f.listingId).map(f => f.listingId));
  } catch { res.status(500).json({ error: 'Failed to load favorites' }); }
});

app.get('/api/favorites/ids', authMiddleware, async (req, res) => {
  try {
    const favs = await Favorite.find({ userId: req.user.id }, 'listingId');
    res.json(favs.map(f => f.listingId));
  } catch { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/favorites/:listingId', authMiddleware, async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.listingId);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    await Favorite.updateOne(
      { userId: req.user.id, listingId: req.params.listingId },
      { $setOnInsert: { userId: req.user.id, listingId: req.params.listingId } },
      { upsert: true }
    );
    res.json({ message: 'Saved', favorited: true });
  } catch { res.status(500).json({ error: 'Failed to save favorite' }); }
});

app.delete('/api/favorites/:listingId', authMiddleware, async (req, res) => {
  try {
    await Favorite.deleteOne({ userId: req.user.id, listingId: req.params.listingId });
    res.json({ message: 'Removed', favorited: false });
  } catch { res.status(500).json({ error: 'Failed to remove favorite' }); }
});

// ─── Reviews ──────────────────────────────────────────────────────────────────
app.get('/api/listings/:id/reviews', async (req, res) => {
  try {
    const { sort = 'newest', minRating, maxRating } = req.query;
    const filter = { listingId: req.params.id, isDeleted: false };
    if (minRating) filter.rating = { ...filter.rating, $gte: Number(minRating) };
    if (maxRating) filter.rating = { ...filter.rating, $lte: Number(maxRating) };
    const sortMap = { newest: { createdAt: -1 }, oldest: { createdAt: 1 }, highest: { rating: -1 }, lowest: { rating: 1 }, helpful: { helpfulVotes: -1 } };
    const reviews = await Review.find(filter)
      .populate('userId', 'email displayName avatar')
      .sort(sortMap[sort] || { createdAt: -1 });
    res.json(reviews);
  } catch { res.status(500).json({ error: 'Failed to load reviews' }); }
});

app.get('/api/listings/:id/reviews/stats', async (req, res) => {
  try {
    const agg = await Review.aggregate([
      { $match: { listingId: new mongoose.Types.ObjectId(req.params.id), isDeleted: false } },
      { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 },
          r1: { $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] } },
          r2: { $sum: { $cond: [{ $eq: ['$rating', 2] }, 1, 0] } },
          r3: { $sum: { $cond: [{ $eq: ['$rating', 3] }, 1, 0] } },
          r4: { $sum: { $cond: [{ $eq: ['$rating', 4] }, 1, 0] } },
          r5: { $sum: { $cond: [{ $eq: ['$rating', 5] }, 1, 0] } },
      }},
    ]);
    if (!agg.length) return res.json({ avg: 0, count: 0, distribution: { 1:0,2:0,3:0,4:0,5:0 } });
    const { avg, count, r1, r2, r3, r4, r5 } = agg[0];
    res.json({ avg: Math.round(avg * 10) / 10, count, distribution: { 1:r1,2:r2,3:r3,4:r4,5:r5 } });
  } catch { res.status(500).json({ error: 'Failed to get stats' }); }
});

app.post('/api/listings/:id/reviews', authMiddleware, async (req, res) => {
  try {
    const { rating, comment, title = '' } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1–5' });

    const booking = await Booking.findOne({
      listingId: req.params.id,
      userId:    req.user.id,
      status:    { $in: ['pending', 'confirmed'] },
    });
    if (!booking) return res.status(403).json({ error: 'You can only review listings you have booked' });

    let review;
    try {
      review = await Review.create({
        listingId: req.params.id,
        userId:    req.user.id,
        rating:    Number(rating),
        comment:   sanitise(comment),
        title:     sanitise(title),
      });
    } catch (e) {
      if (e.code === 11000) return res.status(409).json({ error: 'You have already reviewed this listing' });
      throw e;
    }

    const agg = await Review.aggregate([
      { $match: { listingId: new mongoose.Types.ObjectId(req.params.id), isDeleted: false } },
      { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);
    if (agg.length) {
      await Listing.findByIdAndUpdate(req.params.id, {
        avgRating:   Math.round(agg[0].avg * 10) / 10,
        reviewCount: agg[0].count,
      });
    }

    // Mark booking as guest-reviewed
    await Booking.findByIdAndUpdate(booking._id, { guestReviewedListing: true });

    // Notify the host
    const listing = await Listing.findById(req.params.id);
    if (listing?.ownerId) {
      await notify(listing.ownerId, {
        type: 'review_left', icon: '⭐', priority: 'medium',
        title: `New ${rating}★ review on ${listing.title}`,
        message: comment ? sanitise(comment).slice(0, 120) : 'Guest left a review.',
        actionUrl: `/listing.html?id=${listing._id}`, actionText: 'View Review',
        data: { listingId: listing._id, reviewId: review._id, rating },
      });
    }

    res.json({ message: 'Review submitted ✅', review });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to submit review' }); }
});

// Update own review
app.patch('/api/reviews/:id', authMiddleware, async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review || review.isDeleted) return res.status(404).json({ error: 'Review not found' });
    if (review.userId.toString() !== req.user.id) return res.status(403).json({ error: 'Not your review' });
    const { rating, comment, title } = req.body;
    if (rating  !== undefined) review.rating  = Number(rating);
    if (comment !== undefined) review.comment = sanitise(comment);
    if (title   !== undefined) review.title   = sanitise(title);
    await review.save();
    // Recalculate avg
    const agg = await Review.aggregate([
      { $match: { listingId: review.listingId, isDeleted: false } },
      { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);
    if (agg.length) await Listing.findByIdAndUpdate(review.listingId, { avgRating: Math.round(agg[0].avg * 10) / 10, reviewCount: agg[0].count });
    res.json({ message: 'Review updated ✅', review });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update review' }); }
});

// Soft delete review
app.delete('/api/reviews/:id', authMiddleware, async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    const me = await User.findById(req.user.id);
    if (review.userId.toString() !== req.user.id && !me?.isAdmin) return res.status(403).json({ error: 'Not allowed' });
    review.isDeleted = true;
    await review.save();
    // Recalculate avg
    const agg = await Review.aggregate([
      { $match: { listingId: review.listingId, isDeleted: false } },
      { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);
    await Listing.findByIdAndUpdate(review.listingId, {
      avgRating:   agg.length ? Math.round(agg[0].avg * 10) / 10 : 0,
      reviewCount: agg.length ? agg[0].count : 0,
    });
    res.json({ message: 'Review deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to delete review' }); }
});

// Mark review as helpful
app.post('/api/reviews/:id/helpful', authMiddleware, async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review || review.isDeleted) return res.status(404).json({ error: 'Review not found' });
    const uid = new mongoose.Types.ObjectId(req.user.id);
    const already = review.helpfulVotes.some(v => v.toString() === req.user.id);
    if (already) {
      review.helpfulVotes = review.helpfulVotes.filter(v => v.toString() !== req.user.id);
      await review.save();
      return res.json({ message: 'Removed helpful vote', helpfulCount: review.helpfulVotes.length });
    }
    review.helpfulVotes.push(uid);
    await review.save();
    res.json({ message: 'Marked as helpful ✅', helpfulCount: review.helpfulVotes.length });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

// Host response to review
app.post('/api/reviews/:id/response', authMiddleware, async (req, res) => {
  try {
    const review  = await Review.findById(req.params.id);
    if (!review || review.isDeleted) return res.status(404).json({ error: 'Review not found' });
    const listing = await Listing.findById(review.listingId);
    if (!listing || listing.ownerId.toString() !== req.user.id) return res.status(403).json({ error: 'Only the host can respond' });
    const { response } = req.body;
    if (!response || !response.trim()) return res.status(400).json({ error: 'Response text required' });
    review.hostResponse   = sanitise(response);
    review.hostResponseAt = new Date();
    await review.save();
    res.json({ message: 'Response added ✅', review });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to add response' }); }
});

// Host: all reviews across their listings
app.get('/api/dashboard/reviews', authMiddleware, async (req, res) => {
  try {
    const listings = await Listing.find({ ownerId: req.user.id }, '_id');
    const ids = listings.map(l => l._id);
    const reviews = await Review.find({ listingId: { $in: ids }, isDeleted: false })
      .populate('userId', 'email displayName avatar')
      .populate('listingId', 'title city')
      .sort({ createdAt: -1 });
    res.json(reviews);
  } catch { res.status(500).json({ error: 'Failed to load reviews' }); }
});

// ─── Availability ─────────────────────────────────────────────────────────────
app.get('/api/listings/:id/availability', async (req, res) => {
  try {
    const { checkIn, checkOut } = req.query;
    if (!checkIn || !checkOut) return res.status(400).json({ error: 'checkIn and checkOut required' });
    const ciDate = new Date(checkIn), coDate = new Date(checkOut);
    const conflict = await Booking.findOne({
      listingId: req.params.id, status: { $in: ['pending', 'confirmed'] },
      $or: [{ checkIn: { $lt: coDate }, checkOut: { $gt: ciDate } }],
    });
    res.json({ available: !conflict, conflict: conflict ? { checkIn: conflict.checkIn, checkOut: conflict.checkOut } : null });
  } catch { res.status(500).json({ error: 'Availability check failed' }); }
});

app.get('/api/listings/:id/booked-dates', async (req, res) => {
  try {
    const bookings = await Booking.find({
      listingId: req.params.id, status: { $in: ['pending', 'confirmed'] }, checkOut: { $gte: new Date() },
    }, 'checkIn checkOut');
    res.json(bookings);
  } catch { res.status(500).json({ error: 'Failed to load booked dates' }); }
});

// ─── Bookings ─────────────────────────────────────────────────────────────────
async function createBooking({ listingId, userId, checkIn, checkOut, guests, paid }) {
  const ciDate = new Date(checkIn), coDate = new Date(checkOut);
  if (coDate <= ciDate) throw Object.assign(new Error('checkOut must be after checkIn'), { status: 400 });

  const conflict = await Booking.findOne({
    listingId, status: { $in: ['pending', 'confirmed'] },
    $or: [{ checkIn: { $lt: coDate }, checkOut: { $gt: ciDate } }],
  });
  if (conflict) throw Object.assign(new Error('Those dates are already booked.'), { status: 409 });

  const listing = await Listing.findById(listingId);
  if (!listing) throw Object.assign(new Error('Listing not found'), { status: 404 });

  const g = Math.max(1, Number(guests) || 1);
  if (g > listing.maxGuests) throw Object.assign(new Error(`This place holds at most ${listing.maxGuests} guests`), { status: 400 });

  const { nights, total: totalPrice } = quotePrice(listing, ciDate, coDate);
  // v18: instant_book listings auto-confirm
  const autoConfirm = paid || listing.bookingMode === 'instant_book';
  const booking = await Booking.create({
    listingId, userId, checkIn: ciDate, checkOut: coDate, guests: g,
    totalPrice, nights, status: autoConfirm ? 'confirmed' : 'pending', paid: !!paid,
  });

  const user = await User.findById(userId);
  if (user) sendMail(bookingConfirmationEmail(user.email, listing, booking));

  // Create payout record for auto-confirmed bookings
  if (autoConfirm && listing.ownerId) await createPayoutRecord(booking, listing);

  // Notify host of new booking
  if (listing.ownerId) {
    await notify(listing.ownerId, {
      type: 'booking_request', icon: '🏠', priority: 'high',
      title: autoConfirm ? `New instant booking — ${listing.title}` : `New booking request — ${listing.title}`,
      message: `${user?.email || 'A guest'} booked ${nights} night${nights !== 1 ? 's' : ''} (€${totalPrice})`,
      actionUrl: `/dashboard.html`, actionText: 'View Bookings',
      data: { bookingId: booking._id, listingId },
    });
  }
  // Notify guest
  await notify(userId, {
    type: autoConfirm ? 'booking_confirmed' : 'booking_request', icon: '📅',
    priority: 'high',
    title: autoConfirm ? 'Booking Confirmed! 🎉' : 'Booking Requested ⏳',
    message: autoConfirm
      ? `${listing.title} — ${nights} night${nights !== 1 ? 's' : ''} from €${totalPrice}. You're all set!`
      : `${listing.title} — awaiting host approval.`,
    actionUrl: `/mybookings.html`, actionText: 'View Booking',
    data: { bookingId: booking._id, listingId },
  });

  return { booking, totalPrice, nights, listing };
}

// Create or update a payout record for a booking (called on confirm)
async function createPayoutRecord(booking, listing) {
  try {
    const PLATFORM_FEE_RATE = 0.05;
    const gross      = booking.totalPrice || 0;
    const fee        = Math.round(gross * PLATFORM_FEE_RATE * 100) / 100;
    const earnings   = Math.round((gross - fee) * 100) / 100;
    const d          = new Date(booking.checkIn || booking.createdAt);
    await Payout.findOneAndUpdate(
      { bookingId: booking._id },
      {
        hostId: listing.ownerId, bookingId: booking._id, listingId: listing._id,
        grossAmount: gross, platformFee: fee, hostEarnings: earnings,
        currency: 'EUR', status: 'pending',
        periodYear: d.getFullYear(), periodMonth: d.getMonth() + 1,
      },
      { upsert: true, new: true }
    );
  } catch (e) { console.warn('Payout record failed:', e.message); }
}

async function confirmBookingFromCheckout(sessionObj) {
  const m = sessionObj.metadata || {};
  if (!m.listingId || !m.userId || !m.checkIn || !m.checkOut) return;
  const exists = await Booking.findOne({
    listingId: m.listingId, userId: m.userId,
    checkIn: new Date(m.checkIn), checkOut: new Date(m.checkOut),
  });
  if (exists) {
    if (!exists.paid) { exists.paid = true; exists.status = 'confirmed'; await exists.save(); }
    return;
  }
  await createBooking({
    listingId: m.listingId, userId: m.userId,
    checkIn: m.checkIn, checkOut: m.checkOut, guests: m.guests, paid: true,
  });
}

app.post('/api/bookings', authMiddleware, async (req, res) => {
  try {
    const { listingId, checkIn, checkOut, guests } = req.body;
    if (!listingId || !checkIn || !checkOut) return res.status(400).json({ error: 'listingId, checkIn and checkOut required' });
    const { booking, totalPrice, nights } = await createBooking({ listingId, userId: req.user.id, checkIn, checkOut, guests, paid: false });
    res.json({ message: 'Booking created ✅', booking, totalPrice, nights });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err); res.status(500).json({ error: 'Booking failed' });
  }
});

app.get('/api/bookings/mine', authMiddleware, async (req, res) => {
  try {
    const bookings = await Booking.find({ userId: req.user.id }).populate('listingId', 'title city image price cancellationPolicy').sort({ createdAt: -1 });
    res.json(bookings);
  } catch { res.status(500).json({ error: 'Failed to load bookings' }); }
});

app.delete('/api/bookings/:id', authMiddleware, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.userId.toString() !== req.user.id) return res.status(403).json({ error: 'Not your booking' });
    if (booking.status === 'confirmed') return res.status(400).json({ error: 'Cannot cancel a confirmed booking — use the cancellation system' });
    booking.status = 'cancelled';
    await booking.save();
    res.json({ message: 'Booking cancelled' });
  } catch { res.status(500).json({ error: 'Cancel failed' }); }
});

// ─── Cancellation System ──────────────────────────────────────────────────────
// Get cancellation policy for a listing
app.get('/api/listings/:id/cancellation-policy', async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id, 'cancellationPolicy cancellationPolicyDescription');
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    res.json({
      policy: listing.cancellationPolicy || 'moderate',
      description: listing.cancellationPolicyDescription || policyDescription(listing.cancellationPolicy),
    });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// Update cancellation policy (host only)
app.patch('/api/listings/:id/cancellation-policy', authMiddleware, async (req, res) => {
  try {
    const { cancellationPolicy } = req.body;
    if (!CANCELLATION_POLICIES.includes(cancellationPolicy)) return res.status(400).json({ error: 'Invalid policy' });
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (listing.ownerId.toString() !== req.user.id) return res.status(403).json({ error: 'Not your listing' });
    listing.cancellationPolicy = cancellationPolicy;
    listing.cancellationPolicyDescription = policyDescription(cancellationPolicy);
    await listing.save();
    res.json({ message: 'Policy updated ✅', cancellationPolicy });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// Get cancellation info / refund estimate for a booking
app.get('/api/bookings/:id/cancellation-info', authMiddleware, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('listingId', 'title cancellationPolicy');
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    const me = await User.findById(req.user.id);
    const isGuest = booking.userId.toString() === req.user.id;
    const isHost  = booking.listingId?.ownerId?.toString() === req.user.id;
    if (!isGuest && !isHost && !me?.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const daysBeforeCheckIn = Math.max(0, Math.floor((new Date(booking.checkIn) - new Date()) / 86400000));
    const policy = booking.listingId?.cancellationPolicy || 'moderate';
    const refundInfo = calcRefund(policy, daysBeforeCheckIn, booking.totalPrice);

    res.json({
      bookingId:        booking._id,
      policy,
      description:      policyDescription(policy),
      daysBeforeCheckIn,
      totalPaid:        booking.totalPrice,
      ...refundInfo,
    });
  } catch { res.status(500).json({ error: 'Failed to get cancellation info' }); }
});

// Request cancellation
app.post('/api/bookings/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const { reason = '' } = req.body;
    const booking = await Booking.findById(req.params.id).populate('listingId');
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status === 'cancelled') return res.status(400).json({ error: 'Already cancelled' });

    const me      = await User.findById(req.user.id);
    const isGuest = booking.userId.toString() === req.user.id;
    const isHost  = booking.listingId?.ownerId?.toString() === req.user.id;
    if (!isGuest && !isHost && !me?.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const daysBeforeCheckIn = Math.max(0, Math.floor((new Date(booking.checkIn) - new Date()) / 86400000));
    const policy  = booking.listingId?.cancellationPolicy || 'moderate';
    const refundInfo = calcRefund(policy, daysBeforeCheckIn, booking.totalPrice);
    const role = me?.isAdmin ? 'admin' : isHost ? 'host' : 'guest';

    const cancellation = await Cancellation.create({
      bookingId: booking._id,
      requestedBy: req.user.id,
      role,
      reason: sanitise(reason),
      policy,
      totalPrice: booking.totalPrice,
      daysBeforeCheckIn,
      ...refundInfo,
      status: role === 'admin' ? 'approved' : 'pending',
    });

    // Auto-approve for admins and immediately process
    if (role === 'admin') {
      booking.status = 'cancelled';
      await booking.save();
    }

    // Notify
    const guestUser = await User.findById(booking.userId);
    if (guestUser) sendMail(cancellationEmail(guestUser.email, booking.listingId, booking, refundInfo.refundAmount));
    if (booking.listingId?.ownerId) {
      await notify(booking.listingId.ownerId, {
        type: 'cancellation_request', icon: '❌', priority: 'high',
        title: `Cancellation Request — ${booking.listingId?.title}`,
        message: `${role === 'guest' ? 'Guest' : 'Admin'} requested cancellation. Refund: €${refundInfo.refundAmount}`,
        actionUrl: '/dashboard.html', actionText: 'Review',
        data: { cancellationId: cancellation._id, bookingId: booking._id },
      });
    }
    await notify(booking.userId, {
      type: 'cancellation_request', icon: '❌', priority: 'high',
      title: 'Cancellation Requested',
      message: `Your cancellation request has been submitted. Estimated refund: €${refundInfo.refundAmount}`,
      data: { cancellationId: cancellation._id },
    });

    res.json({ message: 'Cancellation request submitted', cancellation, refundInfo });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to request cancellation' }); }
});

// Host approves cancellation
app.patch('/api/cancellations/:id/approve', authMiddleware, async (req, res) => {
  try {
    const cancellation = await Cancellation.findById(req.params.id).populate('bookingId');
    if (!cancellation) return res.status(404).json({ error: 'Cancellation not found' });
    if (cancellation.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    const booking = cancellation.bookingId;
    const listing = await Listing.findById(booking.listingId);
    if (!listing || listing.ownerId.toString() !== req.user.id) {
      const me = await User.findById(req.user.id);
      if (!me?.isAdmin) return res.status(403).json({ error: 'Not authorized' });
    }

    cancellation.status = 'approved';
    cancellation.processedAt = new Date();
    await cancellation.save();

    booking.status = 'cancelled';
    await booking.save();

    // Notify guest
    await notify(booking.userId, {
      type: 'cancellation_approved', icon: '✅', priority: 'high',
      title: 'Cancellation Approved',
      message: `Your cancellation was approved. Refund of €${cancellation.refundAmount} will be processed.`,
      data: { cancellationId: cancellation._id },
    });

    res.json({ message: 'Cancellation approved', cancellation });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

// Host rejects cancellation
app.patch('/api/cancellations/:id/reject', authMiddleware, async (req, res) => {
  try {
    const cancellation = await Cancellation.findById(req.params.id).populate('bookingId');
    if (!cancellation) return res.status(404).json({ error: 'Cancellation not found' });
    if (cancellation.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    const booking = cancellation.bookingId;
    const listing = await Listing.findById(booking.listingId);
    if (!listing || listing.ownerId.toString() !== req.user.id) {
      const me = await User.findById(req.user.id);
      if (!me?.isAdmin) return res.status(403).json({ error: 'Not authorized' });
    }

    cancellation.status = 'rejected';
    cancellation.processedAt = new Date();
    await cancellation.save();

    await notify(booking.userId, {
      type: 'cancellation_denied', icon: '⛔', priority: 'high',
      title: 'Cancellation Rejected',
      message: 'Your cancellation request was rejected. Your booking remains active.',
      data: { cancellationId: cancellation._id },
    });

    res.json({ message: 'Cancellation rejected', cancellation });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

// Guest: my cancellations
app.get('/api/guest/cancellations', authMiddleware, async (req, res) => {
  try {
    const cancellations = await Cancellation.find({ requestedBy: req.user.id })
      .populate({ path: 'bookingId', populate: { path: 'listingId', select: 'title city image' } })
      .sort({ createdAt: -1 });
    res.json(cancellations);
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// Host: dashboard cancellations
app.get('/api/dashboard/cancellations', authMiddleware, async (req, res) => {
  try {
    const listings = await Listing.find({ ownerId: req.user.id }, '_id');
    const ids = listings.map(l => l._id);
    const bookings = await Booking.find({ listingId: { $in: ids } }, '_id');
    const bookingIds = bookings.map(b => b._id);
    const cancellations = await Cancellation.find({ bookingId: { $in: bookingIds }, status: 'pending' })
      .populate({ path: 'bookingId', populate: { path: 'listingId', select: 'title city' } })
      .populate('requestedBy', 'email displayName')
      .sort({ createdAt: -1 });
    res.json(cancellations);
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// Admin: all cancellations
app.get('/api/admin/cancellations', adminMiddleware, async (req, res) => {
  try {
    const cancellations = await Cancellation.find()
      .populate({ path: 'bookingId', populate: { path: 'listingId', select: 'title city' } })
      .populate('requestedBy', 'email')
      .sort({ createdAt: -1 });
    res.json(cancellations);
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// ─── House Rules ──────────────────────────────────────────────────────────────
// Get rules for a listing (public)
app.get('/api/listings/:id/rules', async (req, res) => {
  try {
    const rules = await HouseRule.findOne({ listingId: req.params.id });
    res.json(rules || { listingId: req.params.id, rules: [] });
  } catch { res.status(500).json({ error: 'Failed to load rules' }); }
});

// Set/update rules (host only)
app.post('/api/listings/:id/rules', authMiddleware, async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (listing.ownerId.toString() !== req.user.id) return res.status(403).json({ error: 'Not your listing' });

    const { rules = [] } = req.body;
    const clean = rules.map((r, i) => ({
      ruleId:      r.ruleId || `rule_${Date.now()}_${i}`,
      category:    ['pets','smoking','noise','guests','parking','check-in','check-out','kitchen','general'].includes(r.category) ? r.category : 'general',
      title:       sanitise(r.title).slice(0, 100),
      description: sanitise(r.description || '').slice(0, 500),
      required:    !!r.required,
    })).filter(r => r.title);

    const houseRule = await HouseRule.findOneAndUpdate(
      { listingId: req.params.id },
      { listingId: req.params.id, hostId: req.user.id, rules: clean },
      { upsert: true, new: true }
    );
    res.json({ message: 'Rules updated ✅', houseRule });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update rules' }); }
});

// Guest acknowledges rules before booking
app.post('/api/bookings/:bookingId/acknowledge-rules', authMiddleware, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.userId.toString() !== req.user.id) return res.status(403).json({ error: 'Not your booking' });

    const houseRules = await HouseRule.findOne({ listingId: booking.listingId });
    const { acknowledgedRuleIds = [] } = req.body;

    const acknowledgedRules = (houseRules?.rules || [])
      .filter(r => acknowledgedRuleIds.includes(r.ruleId))
      .map(r => ({ ruleId: r.ruleId, title: r.title, acknowledgedAt: new Date() }));

    const requiredRules  = (houseRules?.rules || []).filter(r => r.required);
    const allAcknowledged = requiredRules.every(r => acknowledgedRuleIds.includes(r.ruleId));

    await RuleAcknowledgment.findOneAndUpdate(
      { bookingId: booking._id },
      { bookingId: booking._id, guestId: req.user.id, listingId: booking.listingId, acknowledgedRules, allRulesAcknowledged: allAcknowledged, acknowledgedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ message: `${acknowledgedRules.length} rule(s) acknowledged`, allRulesAcknowledged: allAcknowledged });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

// Get acknowledgment status for a booking
app.get('/api/bookings/:bookingId/acknowledgment', authMiddleware, async (req, res) => {
  try {
    const ack = await RuleAcknowledgment.findOne({ bookingId: req.params.bookingId });
    res.json(ack || { allRulesAcknowledged: false, acknowledgedRules: [] });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// ─── Host Dashboard ───────────────────────────────────────────────────────────
app.get('/api/host/listings', authMiddleware, async (req, res) => {
  try {
    const listings = await Listing.find({ ownerId: req.user.id }).sort({ createdAt: -1 }).lean();
    const ids = listings.map(l => l._id);
    const counts = await Booking.aggregate([
      { $match: { listingId: { $in: ids } } },
      { $group: { _id: '$listingId', total: { $sum: 1 }, pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } } } },
    ]);
    const byId = Object.fromEntries(counts.map(c => [c._id.toString(), c]));
    listings.forEach(l => {
      const c = byId[l._id.toString()];
      l.bookingCount = c?.total   || 0;
      l.pendingCount = c?.pending || 0;
    });
    res.json(listings);
  } catch { res.status(500).json({ error: 'Failed to load host listings' }); }
});

app.get('/api/host/bookings', authMiddleware, async (req, res) => {
  try {
    const listings = await Listing.find({ ownerId: req.user.id }, '_id');
    const ids = listings.map(l => l._id);
    const bookings = await Booking.find({ listingId: { $in: ids } })
      .populate('listingId', 'title city image')
      .populate('userId', 'email displayName')
      .sort({ createdAt: -1 });
    res.json(bookings);
  } catch { res.status(500).json({ error: 'Failed to load host bookings' }); }
});

app.patch('/api/host/bookings/:id/confirm', authMiddleware, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('listingId');
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.listingId || booking.listingId.ownerId.toString() !== req.user.id) return res.status(403).json({ error: 'Not your listing' });
    booking.status = 'confirmed';
    await booking.save();
    // Create payout record
    await createPayoutRecord(booking, booking.listingId);
    // Notify guest
    await notify(booking.userId, {
      type: 'booking_confirmed', icon: '🎉', priority: 'high',
      title: 'Booking Confirmed! 🎉',
      message: `Your booking for ${booking.listingId.title} has been confirmed by the host.`,
      actionUrl: '/mybookings.html', actionText: 'View Booking',
      data: { bookingId: booking._id },
    });
    res.json({ message: 'Booking confirmed', booking });
  } catch { res.status(500).json({ error: 'Failed to confirm' }); }
});

app.patch('/api/host/bookings/:id/reject', authMiddleware, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('listingId');
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.listingId || booking.listingId.ownerId.toString() !== req.user.id) return res.status(403).json({ error: 'Not your listing' });
    booking.status = 'cancelled';
    await booking.save();
    await notify(booking.userId, {
      type: 'booking_cancelled', icon: '❌', priority: 'high',
      title: 'Booking Rejected',
      message: `Your booking for ${booking.listingId.title} was not accepted by the host.`,
      data: { bookingId: booking._id },
    });
    res.json({ message: 'Booking rejected', booking });
  } catch { res.status(500).json({ error: 'Failed to reject' }); }
});

// ─── Stripe Checkout ──────────────────────────────────────────────────────────
app.post('/api/create-checkout-session', authMiddleware, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured (STRIPE_KEY missing)' });
  const { listingId, checkIn, checkOut, guests } = req.body;
  try {
    const ciDate = new Date(checkIn), coDate = new Date(checkOut);
    const conflict = await Booking.findOne({
      listingId, status: { $in: ['pending', 'confirmed'] },
      $or: [{ checkIn: { $lt: coDate }, checkOut: { $gt: ciDate } }],
    });
    if (conflict) return res.status(409).json({ error: 'Those dates are already booked.' });

    const listing = await Listing.findById(listingId);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    const g = Math.max(1, Number(guests) || 1);
    if (g > listing.maxGuests) return res.status(400).json({ error: `This place holds at most ${listing.maxGuests} guests` });

    const { nights, total } = quotePrice(listing, ciDate, coDate);
    const sess = await stripe.checkout.sessions.create({
      payment_method_types: ['card'], mode: 'payment',
      line_items: [{ price_data: { currency: 'eur', product_data: { name: `${listing.title} — ${nights} night${nights !== 1 ? 's' : ''}` }, unit_amount: Math.round(total * 100) }, quantity: 1 }],
      metadata: { listingId: listingId.toString(), checkIn, checkOut, guests: String(g), userId: req.user.id },
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${BASE_URL}/cancel.html`,
    });
    res.json({ url: sess.url });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Stripe error: ' + err.message }); }
});

// ─── Messaging ────────────────────────────────────────────────────────────────
app.post('/api/messages', authMiddleware, async (req, res) => {
  try {
    const { listingId, body, toId } = req.body;
    if (!listingId || !body || !body.trim()) return res.status(400).json({ error: 'listingId and message body required' });

    const listing = await Listing.findById(listingId);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (!listing.ownerId) return res.status(400).json({ error: 'This listing has no host to contact' });

    const ownerId = listing.ownerId.toString();
    let recipient;
    if (req.user.id === ownerId) {
      if (!toId) return res.status(400).json({ error: 'Recipient (toId) required when host sends' });
      recipient = toId;
    } else {
      recipient = ownerId;
    }
    if (recipient === req.user.id) return res.status(400).json({ error: 'Cannot message yourself' });

    const msg = await Message.create({ listingId, fromId: req.user.id, toId: recipient, body: sanitise(body) });

    const toUser = await User.findById(recipient);
    if (toUser) sendMail(messageEmail(toUser.email, req.user.email, listing, sanitise(body)));

    // In-app notification for new message
    await notify(recipient, {
      type: 'new_message', icon: '💬', priority: 'medium',
      title: `New message about ${listing.title}`,
      message: sanitise(body).slice(0, 100),
      actionUrl: `/messages.html?listing=${listingId}&with=${req.user.id}`,
      actionText: 'Reply',
      data: { messageId: msg._id, listingId },
    });

    res.json({ message: 'Sent ✅', data: msg });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to send message' }); }
});

app.get('/api/messages/threads', authMiddleware, async (req, res) => {
  try {
    const me = new mongoose.Types.ObjectId(req.user.id);
    const msgs = await Message.find({ $or: [{ fromId: me }, { toId: me }] })
      .populate('listingId', 'title city image ownerId')
      .populate('fromId', 'email displayName')
      .populate('toId', 'email displayName')
      .sort({ createdAt: -1 });

    const threads = {};
    for (const m of msgs) {
      if (!m.listingId) continue;
      const other = m.fromId._id.toString() === req.user.id ? m.toId : m.fromId;
      const key = `${m.listingId._id}_${other._id}`;
      if (!threads[key]) {
        threads[key] = { listing: m.listingId, other, lastMessage: m.body, lastAt: m.createdAt, unread: 0 };
      }
      if (!m.read && m.toId._id.toString() === req.user.id) threads[key].unread++;
    }
    res.json(Object.values(threads).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt)));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load threads' }); }
});

app.get('/api/messages/thread/:listingId/:otherId', authMiddleware, async (req, res) => {
  try {
    const { listingId, otherId } = req.params;
    const me = req.user.id;
    const msgs = await Message.find({
      listingId,
      $or: [{ fromId: me, toId: otherId }, { fromId: otherId, toId: me }],
    }).sort({ createdAt: 1 });
    await Message.updateMany({ listingId, fromId: otherId, toId: me, read: false }, { read: true });
    res.json(msgs);
  } catch { res.status(500).json({ error: 'Failed to load conversation' }); }
});

app.get('/api/messages/unread-count', authMiddleware, async (req, res) => {
  try {
    const count = await Message.countDocuments({ toId: req.user.id, read: false });
    res.json({ count });
  } catch { res.json({ count: 0 }); }
});

// ─── Notifications ────────────────────────────────────────────────────────────
// Get my notifications
app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const { limit = 30, unreadOnly } = req.query;
    const filter = { userId: req.user.id, isArchived: false };
    if (unreadOnly === 'true') filter.isRead = false;
    const notifications = await Notification.find(filter).sort({ createdAt: -1 }).limit(Number(limit));
    const unreadCount   = await Notification.countDocuments({ userId: req.user.id, isRead: false, isArchived: false });
    res.json({ notifications, unreadCount });
  } catch { res.status(500).json({ error: 'Failed to load notifications' }); }
});

// Unread count (lightweight, for nav badge)
app.get('/api/notifications/unread-count', authMiddleware, async (req, res) => {
  try {
    const count = await Notification.countDocuments({ userId: req.user.id, isRead: false, isArchived: false });
    res.json({ count });
  } catch { res.json({ count: 0 }); }
});

// Mark one as read
app.post('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    const n = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { isRead: true },
      { new: true }
    );
    if (!n) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Marked as read', notification: n });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// Mark all as read
app.post('/api/notifications/read-all', authMiddleware, async (req, res) => {
  try {
    const result = await Notification.updateMany({ userId: req.user.id, isRead: false }, { isRead: true });
    res.json({ message: 'All notifications marked as read', modified: result.modifiedCount });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// Archive one
app.post('/api/notifications/:id/archive', authMiddleware, async (req, res) => {
  try {
    const n = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { isArchived: true, isRead: true },
      { new: true }
    );
    if (!n) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Archived', notification: n });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// Delete one
app.delete('/api/notifications/:id', authMiddleware, async (req, res) => {
  try {
    await Notification.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    res.json({ message: 'Notification deleted' });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// Admin: send broadcast notification
app.post('/api/admin/notifications/broadcast', adminMiddleware, async (req, res) => {
  try {
    const { title, message, type = 'account_verified', icon = '📢', actionUrl, actionText, userIds } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'title and message required' });
    const query = userIds?.length ? { _id: { $in: userIds } } : {};
    const users = await User.find(query, '_id');
    const docs  = users.map(u => ({ userId: u._id, type, title, message, icon, actionUrl: actionUrl || null, actionText: actionText || 'View' }));
    await Notification.insertMany(docs);
    res.json({ message: `Broadcast sent to ${docs.length} users` });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

// ─── Two-Way Reviews: Host reviews Guest ──────────────────────────────────────
// Host submits a review for a guest after checkout
app.post('/api/bookings/:bookingId/guest-review', authMiddleware, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.bookingId).populate('listingId', 'title ownerId');
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.listingId || booking.listingId.ownerId.toString() !== req.user.id)
      return res.status(403).json({ error: 'Only the host can review guests' });
    if (booking.status !== 'confirmed')
      return res.status(400).json({ error: 'Can only review guests for confirmed bookings' });
    const checkOutDate = new Date(booking.checkOut);
    if (checkOutDate > new Date())
      return res.status(400).json({ error: 'Cannot review guest before checkout' });

    const { rating, comment = '', cleanliness, communication, houseRules } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1–5' });

    let gr;
    try {
      // Explicit pre-check (unique index may lag in some environments)
      const existing = await GuestReview.findOne({ bookingId: booking._id });
      if (existing) return res.status(409).json({ error: 'You have already reviewed this guest for this booking' });

      gr = await GuestReview.create({
        bookingId:     booking._id,
        listingId:     booking.listingId._id,
        guestId:       booking.userId,
        hostId:        req.user.id,
        rating:        Number(rating),
        comment:       sanitise(comment),
        cleanliness:   cleanliness   ? Number(cleanliness)   : undefined,
        communication: communication ? Number(communication) : undefined,
        houseRules:    houseRules    ? Number(houseRules)    : undefined,
      });
    } catch (e) {
      if (e.code === 11000) return res.status(409).json({ error: 'You have already reviewed this guest for this booking' });
      throw e;
    }

    await Booking.findByIdAndUpdate(booking._id, { hostReviewedGuest: true });

    await notify(booking.userId, {
      type: 'review_left', icon: '⭐', priority: 'low',
      title: 'Your host left you a review',
      message: `Your stay at ${booking.listingId.title} received a ${rating}★ review from the host.`,
      actionUrl: '/mybookings.html', actionText: 'View',
      data: { guestReviewId: gr._id },
    });

    await recalcSuperhost(req.user.id);
    res.json({ message: 'Guest review submitted ✅', review: gr });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to submit guest review' }); }
});

// Get all guest reviews written about a specific guest (public)
app.get('/api/users/:userId/guest-reviews', async (req, res) => {
  try {
    const reviews = await GuestReview.find({ guestId: req.params.userId, isDeleted: false })
      .populate('hostId', 'email displayName avatar isSuperhost')
      .populate('listingId', 'title city')
      .sort({ createdAt: -1 });
    res.json(reviews);
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// Host: all guest reviews they've written
app.get('/api/host/guest-reviews', authMiddleware, async (req, res) => {
  try {
    const reviews = await GuestReview.find({ hostId: req.user.id, isDeleted: false })
      .populate('guestId', 'email displayName avatar')
      .populate('listingId', 'title city')
      .sort({ createdAt: -1 });
    res.json(reviews);
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// Bookings pending host guest review
app.get('/api/host/bookings/pending-guest-review', authMiddleware, async (req, res) => {
  try {
    const listings = await Listing.find({ ownerId: req.user.id }, '_id');
    const ids = listings.map(l => l._id);
    const bookings = await Booking.find({
      listingId: { $in: ids },
      status:    'confirmed',
      checkOut:  { $lt: new Date() },
      hostReviewedGuest: false,
    }).populate('userId', 'email displayName avatar')
      .populate('listingId', 'title city image')
      .sort({ checkOut: -1 });
    res.json(bookings);
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// ─── Superhost Badge System ───────────────────────────────────────────────────
const SUPERHOST_THRESHOLDS = {
  minAvgRating:        4.8,
  minTotalBookings:    10,
  minResponseRate:     90,
  maxCancellationRate: 1,
};

async function recalcSuperhost(hostId) {
  try {
    const listings = await Listing.find({ ownerId: hostId }, '_id');
    const listingIds = listings.map(l => l._id);

    const bookings   = await Booking.find({ listingId: { $in: listingIds } });
    const confirmed  = bookings.filter(b => b.status === 'confirmed');
    const cancelled  = bookings.filter(b => b.status === 'cancelled');
    const totalBookings = confirmed.length;

    if (totalBookings === 0) return;

    const ratingAgg = await Review.aggregate([
      { $match: { listingId: { $in: listingIds }, isDeleted: false } },
      { $group: { _id: null, avg: { $avg: '$rating' } } },
    ]);
    const avgRating = ratingAgg.length ? Math.round(ratingAgg[0].avg * 100) / 100 : 0;

    const cancellationRate = Math.round((cancelled.length / (totalBookings + cancelled.length)) * 100);

    const oldPending   = bookings.filter(b => b.status === 'pending' && (Date.now() - new Date(b.createdAt)) > 86400000);
    const responseRate = Math.round((confirmed.length / (confirmed.length + oldPending.length + 0.001)) * 100);

    const qualifies =
      avgRating        >= SUPERHOST_THRESHOLDS.minAvgRating &&
      totalBookings    >= SUPERHOST_THRESHOLDS.minTotalBookings &&
      responseRate     >= SUPERHOST_THRESHOLDS.minResponseRate &&
      cancellationRate <= SUPERHOST_THRESHOLDS.maxCancellationRate;

    const host = await User.findById(hostId);
    if (!host) return;

    const wasSuperhost = host.isSuperhost;
    host.isSuperhost   = qualifies;
    if (qualifies && !wasSuperhost) host.superhostSince = new Date();
    if (!qualifies && wasSuperhost) host.superhostSince = undefined;
    host.superhostStats = { avgRating, totalBookings, responseRate, cancellationRate, lastCalculated: new Date() };
    await host.save();

    if (qualifies && !wasSuperhost) {
      await notify(hostId, {
        type: 'superhost_achieved', icon: '🏆', priority: 'high',
        title: "You're a Superhost! 🏆",
        message: "Congratulations! You've earned Superhost status based on your outstanding reviews, response rate, and booking history.",
        actionUrl: '/host-profile.html', actionText: 'View Badge',
      });
    } else if (!qualifies && wasSuperhost) {
      await notify(hostId, {
        type: 'superhost_lost', icon: '⚠️', priority: 'medium',
        title: 'Superhost Status Updated',
        message: 'Your Superhost status has changed. Keep up great reviews and response times to re-qualify.',
        actionUrl: '/host-profile.html', actionText: 'View Stats',
      });
    }
  } catch (e) { console.warn('Superhost recalc failed:', e.message); }
}

// Also trigger recalc when host confirms a booking
app.get('/api/users/:userId/superhost-stats', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId, 'isSuperhost superhostSince superhostStats displayName email avatar');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ isSuperhost: user.isSuperhost, superhostSince: user.superhostSince, stats: user.superhostStats, thresholds: SUPERHOST_THRESHOLDS });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/admin/recalc-superhosts', adminMiddleware, async (req, res) => {
  try {
    const hostIds = await Listing.distinct('ownerId');
    await Promise.all(hostIds.map(id => recalcSuperhost(id)));
    res.json({ message: `Recalculated superhost status for ${hostIds.length} hosts` });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

// ─── Public Host Profile ──────────────────────────────────────────────────────
app.get('/api/users/:userId/profile', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId, '-password -verificationToken -verificationTokenExpires');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const listings = await Listing.find({ ownerId: req.params.userId }).sort({ avgRating: -1, createdAt: -1 }).lean();
    const listingIds = listings.map(l => l._id);
    const reviewCount = await Review.countDocuments({ listingId: { $in: listingIds }, isDeleted: false });

    res.json({
      user: {
        _id: user._id, displayName: user.displayName, email: user.email,
        avatar: user.avatar, bio: user.bio, location: user.location,
        isSuperhost: user.isSuperhost, superhostSince: user.superhostSince,
        superhostStats: user.superhostStats, memberSince: user.createdAt,
      },
      listings,
      reviewCount,
    });
  } catch { res.status(500).json({ error: 'Failed to load profile' }); }
});

// Update own profile (displayName, bio, location, avatar)
app.patch('/api/me/profile', authMiddleware, async (req, res) => {
  try {
    const { displayName, bio, location, avatar } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (displayName !== undefined) user.displayName = sanitise(displayName).slice(0, 80);
    if (bio         !== undefined) user.bio         = sanitise(bio).slice(0, 500);
    if (location    !== undefined) user.location    = sanitise(location).slice(0, 100);
    if (avatar      !== undefined) user.avatar      = avatar;
    await user.save();
    res.json({ message: 'Profile updated ✅', user: { _id: user._id, displayName: user.displayName, bio: user.bio, location: user.location, avatar: user.avatar } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

// ─── Check-in Instructions ───────────────────────────────────────────────────
// Host: set instructions for a listing
app.put('/api/listings/:id/checkin-instructions', authMiddleware, async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (listing.ownerId.toString() !== req.user.id) return res.status(403).json({ error: 'Not your listing' });

    const {
      accessCode, wifiNetwork, wifiPassword, checkInTime, checkOutTime,
      parkingInfo, directions, emergencyContact, additionalNotes,
      revealHoursBeforeCheckin = 24,
    } = req.body;

    const instructions = await CheckinInstruction.findOneAndUpdate(
      { listingId: req.params.id },
      {
        listingId: req.params.id,
        hostId: req.user.id,
        accessCode:       sanitise(accessCode || '').slice(0, 200),
        wifiNetwork:      sanitise(wifiNetwork || '').slice(0, 100),
        wifiPassword:     sanitise(wifiPassword || '').slice(0, 100),
        checkInTime:      sanitise(checkInTime || '').slice(0, 50),
        checkOutTime:     sanitise(checkOutTime || '').slice(0, 50),
        parkingInfo:      sanitise(parkingInfo || '').slice(0, 500),
        directions:       sanitise(directions || '').slice(0, 1000),
        emergencyContact: sanitise(emergencyContact || '').slice(0, 200),
        additionalNotes:  sanitise(additionalNotes || '').slice(0, 2000),
        revealHoursBeforeCheckin: Math.max(0, Math.min(168, Number(revealHoursBeforeCheckin) || 24)),
      },
      { upsert: true, new: true }
    );
    res.json({ message: 'Check-in instructions saved ✅', instructions });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to save instructions' }); }
});

// Host: view their own instructions
app.get('/api/listings/:id/checkin-instructions', authMiddleware, async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (listing.ownerId.toString() !== req.user.id) return res.status(403).json({ error: 'Not your listing' });
    const instructions = await CheckinInstruction.findOne({ listingId: req.params.id });
    res.json(instructions || { listingId: req.params.id, message: 'No instructions set yet' });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// Guest: view instructions for a confirmed booking (gated by time)
app.get('/api/bookings/:id/checkin-instructions', authMiddleware, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('listingId', 'title city ownerId');
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.userId.toString() !== req.user.id) return res.status(403).json({ error: 'Not your booking' });
    if (booking.status !== 'confirmed') return res.status(403).json({ error: 'Instructions only available for confirmed bookings' });

    const instructions = await CheckinInstruction.findOne({ listingId: booking.listingId._id });
    if (!instructions) return res.json({ message: 'Host has not added check-in instructions yet' });

    // Enforce reveal window
    const hoursUntilCheckIn = (new Date(booking.checkIn) - new Date()) / 3600000;
    const isRevealed = hoursUntilCheckIn <= instructions.revealHoursBeforeCheckin || hoursUntilCheckIn < 0;

    if (!isRevealed) {
      return res.json({
        available: false,
        revealAt: new Date(new Date(booking.checkIn).getTime() - instructions.revealHoursBeforeCheckin * 3600000),
        message: `Instructions will be available ${instructions.revealHoursBeforeCheckin} hours before check-in`,
      });
    }

    res.json({ available: true, instructions });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

// ─── Revenue & Earnings Dashboard ────────────────────────────────────────────
// Summary: total earnings, this month, last month, all-time
app.get('/api/host/revenue/summary', authMiddleware, async (req, res) => {
  try {
    const listings = await Listing.find({ ownerId: req.user.id }, '_id');
    const listingIds = listings.map(l => l._id);

    const now      = new Date();
    const thisYear = now.getFullYear();
    const thisMon  = now.getMonth() + 1;
    const lastMon  = thisMon === 1 ? 12 : thisMon - 1;
    const lastYear = thisMon === 1 ? thisYear - 1 : thisYear;

    const payouts = await Payout.find({ hostId: req.user.id, status: { $ne: 'cancelled' } });

    const allTime   = payouts.reduce((s, p) => s + p.hostEarnings, 0);
    const thisMonth = payouts.filter(p => p.periodYear === thisYear && p.periodMonth === thisMon)
                             .reduce((s, p) => s + p.hostEarnings, 0);
    const lastMonth = payouts.filter(p => p.periodYear === lastYear && p.periodMonth === lastMon)
                             .reduce((s, p) => s + p.hostEarnings, 0);
    const pending   = payouts.filter(p => p.status === 'pending').reduce((s, p) => s + p.hostEarnings, 0);

    // Occupancy: confirmed bookings / 365 nights
    const confirmedBookings = await Booking.find({ listingId: { $in: listingIds }, status: 'confirmed' });
    const totalNights = confirmedBookings.reduce((s, b) => s + (b.nights || 0), 0);
    const occupancyRate = listings.length > 0
      ? Math.round((totalNights / (listings.length * 365)) * 100)
      : 0;

    res.json({
      allTime:       Math.round(allTime * 100) / 100,
      thisMonth:     Math.round(thisMonth * 100) / 100,
      lastMonth:     Math.round(lastMonth * 100) / 100,
      pendingPayout: Math.round(pending * 100) / 100,
      totalBookings: confirmedBookings.length,
      totalNights,
      occupancyRate,
      listingCount:  listings.length,
      currency: 'EUR',
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load revenue summary' }); }
});

// Monthly breakdown — last 12 months
app.get('/api/host/revenue/monthly', authMiddleware, async (req, res) => {
  try {
    const payouts = await Payout.find({ hostId: req.user.id, status: { $ne: 'cancelled' } });

    // Build a map: "YYYY-MM" → { earnings, bookings, nights }
    const byMonth = {};
    for (const p of payouts) {
      const key = `${p.periodYear}-${String(p.periodMonth).padStart(2, '0')}`;
      if (!byMonth[key]) byMonth[key] = { year: p.periodYear, month: p.periodMonth, earnings: 0, bookings: 0 };
      byMonth[key].earnings  += p.hostEarnings;
      byMonth[key].bookings  += 1;
    }

    // Return sorted, last 24 months max
    const months = Object.entries(byMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-24)
      .map(([key, v]) => ({ ...v, earnings: Math.round(v.earnings * 100) / 100, key }));

    res.json(months);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load monthly revenue' }); }
});

// Per-listing revenue breakdown
app.get('/api/host/revenue/by-listing', authMiddleware, async (req, res) => {
  try {
    const payouts = await Payout.find({ hostId: req.user.id, status: { $ne: 'cancelled' } })
      .populate('listingId', 'title city image price');

    const byListing = {};
    for (const p of payouts) {
      const lid = p.listingId?._id?.toString();
      if (!lid) continue;
      if (!byListing[lid]) {
        byListing[lid] = { listing: p.listingId, earnings: 0, bookings: 0, grossRevenue: 0 };
      }
      byListing[lid].earnings     += p.hostEarnings;
      byListing[lid].grossRevenue += p.grossAmount;
      byListing[lid].bookings     += 1;
    }

    const result = Object.values(byListing).map(v => ({
      ...v,
      earnings:     Math.round(v.earnings * 100) / 100,
      grossRevenue: Math.round(v.grossRevenue * 100) / 100,
    })).sort((a, b) => b.earnings - a.earnings);

    res.json(result);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load per-listing revenue' }); }
});

// Full payout history (paginated)
app.get('/api/host/revenue/payouts', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const filter = { hostId: req.user.id };
    if (status) filter.status = status;
    const total = await Payout.countDocuments(filter);
    const payouts = await Payout.find(filter)
      .populate('bookingId', 'checkIn checkOut nights guests')
      .populate('listingId', 'title city')
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit));
    res.json({ payouts, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load payouts' }); }
});

// Admin: mark payout as paid
app.patch('/api/admin/payouts/:id/mark-paid', adminMiddleware, async (req, res) => {
  try {
    const payout = await Payout.findByIdAndUpdate(
      req.params.id,
      { status: 'paid', paidAt: new Date() },
      { new: true }
    );
    if (!payout) return res.status(404).json({ error: 'Payout not found' });
    // Notify host
    await notify(payout.hostId, {
      type: 'payment_received', icon: '💰', priority: 'high',
      title: `Payout of €${payout.hostEarnings} processed`,
      message: `Your earnings of €${payout.hostEarnings} have been paid out.`,
      actionUrl: '/revenue.html', actionText: 'View Earnings',
      data: { payoutId: payout._id },
    });
    res.json({ message: 'Payout marked as paid', payout });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// Admin: all pending payouts
app.get('/api/admin/payouts/pending', adminMiddleware, async (req, res) => {
  try {
    const payouts = await Payout.find({ status: 'pending' })
      .populate('hostId', 'email displayName')
      .populate('listingId', 'title city')
      .sort({ createdAt: -1 });
    res.json(payouts);
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// ─── Admin ────────────────────────────────────────────────────────────────────
app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  try { res.json(await User.find({}, '-password').sort({ createdAt: -1 })); }
  catch { res.status(500).json({ error: 'Failed to load users' }); }
});

app.get('/api/admin/bookings', adminMiddleware, async (req, res) => {
  try { res.json(await Booking.find().populate('listingId', 'title city price').populate('userId', 'email').sort({ createdAt: -1 })); }
  catch { res.status(500).json({ error: 'Failed to load bookings' }); }
});

app.get('/api/admin/listings', adminMiddleware, async (req, res) => {
  try { res.json(await Listing.find().populate('ownerId', 'email displayName').sort({ createdAt: -1 })); }
  catch { res.status(500).json({ error: 'Failed to load listings', detail: err.message, name: err.name }); }
});

app.patch('/api/admin/users/:id/ban', adminMiddleware, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { isBanned: true }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User banned', user });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

app.patch('/api/admin/users/:id/unban', adminMiddleware, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { isBanned: false }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User unbanned', user });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// ─── Start ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => console.log(`🚀 Stay${COUNTRY} v19 running on http://localhost:${PORT}`));
}

module.exports = { app, mongoose, models: { User, Listing, Booking, Review, GuestReview, Favorite, Message, Notification, HouseRule, RuleAcknowledgment, Cancellation, CheckinInstruction, Payout } };
