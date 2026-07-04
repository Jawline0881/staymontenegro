# 🚀 StayMontenegro — Live Demo Deployment Guide

Get your app live in ~20 minutes. You'll need:
- A free [MongoDB Atlas](https://cloud.mongodb.com) account
- A free [Railway](https://railway.app) account (or Render)
- A [GitHub](https://github.com) account

---

## Step 1 — MongoDB Atlas (free database)

1. Go to [cloud.mongodb.com](https://cloud.mongodb.com) → Create a free account
2. Create a new **Free Cluster** (M0 tier, choose any region)
3. When asked for a username/password → create a DB user (e.g. `stayadmin` / generate a strong password — **save it**)
4. Under "Network Access" → Add IP Address → **Allow Access From Anywhere** (`0.0.0.0/0`)
5. Go to your cluster → **Connect** → **Connect your application** → copy the connection string:
   ```
   mongodb+srv://stayadmin:<password>@cluster0.xxxxx.mongodb.net/staymontenegro?retryWrites=true&w=majority
   ```
   Replace `<password>` with your actual password.

This is your `MONGO_URL`.

---

## Step 2 — Push to GitHub

```bash
# In the stayserbia folder:
git init
git add .
git commit -m "StayMontenegro v19 - full production build"

# Create a new repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/staymontenegro.git
git branch -M main
git push -u origin main
```

---

## Step 3 — Deploy on Railway

1. Go to [railway.app](https://railway.app) → Sign up with GitHub
2. Click **New Project** → **Deploy from GitHub repo** → select your repo
3. Railway will auto-detect Node.js and deploy

4. Once deployed, go to your service → **Variables** tab → add these env vars:

| Variable | Value |
|---|---|
| `MONGO_URL` | `mongodb+srv://...` (from Step 1) |
| `JWT_SECRET` | Any long random string (e.g. `openssl rand -hex 32`) |
| `BASE_URL` | Your Railway URL (e.g. `https://staymontenegro-production.up.railway.app`) |
| `COUNTRY` | `Montenegro` |
| `PORT` | `3000` |

5. Optionally add (all optional — app works without them):

| Variable | Purpose |
|---|---|
| `STRIPE_KEY` | Stripe test key for payments (get from [stripe.com/docs/keys](https://stripe.com/docs/keys)) |
| `CLOUDINARY_CLOUD_NAME` | Image hosting (free at cloudinary.com) |
| `CLOUDINARY_API_KEY` | Cloudinary |
| `CLOUDINARY_API_SECRET` | Cloudinary |
| `EMAIL_HOST` | SMTP host (e.g. `smtp.resend.com`) |
| `EMAIL_USER` | SMTP user |
| `EMAIL_PASS` | SMTP password |

6. Railway will auto-redeploy. Your app will be live at the Railway URL.

---

## Step 4 — Seed Demo Data

Once deployed, seed the database with demo listings and accounts:

**Option A: Run locally against Atlas**
```bash
MONGO_URL="mongodb+srv://..." node seed.js
```

**Option B: Run on Railway**
Go to Railway → your service → **Settings** → **Deploy** → add a one-time command:
```
node seed.js
```
Or use the Railway CLI:
```bash
railway run node seed.js
```

After seeding, you'll have:

| Account | Password | Role |
|---|---|---|
| `guest@demo.com` | `demo1234` | Guest traveller |
| `ana@demo.com` | `demo1234` | Superhost 🏆 |
| `marko@demo.com` | `demo1234` | Host |
| `admin@demo.com` | `demo1234` | Admin |

---

## Step 5 — Verify Everything Works

Visit your live URL and check:

- [ ] Home page loads with 6 listings
- [ ] Login as `guest@demo.com`
- [ ] Browse listings, view a listing, check availability
- [ ] Make a booking (instant_book auto-confirms)
- [ ] Login as `ana@demo.com` → check Host dashboard
- [ ] Check Revenue page (`/revenue.html`)
- [ ] Login as `admin@demo.com` → Admin panel (`/admin-dashboard.html`)

---

## Optional: Custom Domain

In Railway → Settings → Domains → Add custom domain.
Then set `BASE_URL` to `https://yourdomain.com`.

---

## Optional: Stripe Test Payments

1. Get test keys from [dashboard.stripe.com/test/apikeys](https://dashboard.stripe.com/test/apikeys)
2. Set `STRIPE_KEY=sk_test_...` in Railway env vars
3. For the webhook (to auto-confirm bookings after payment):
   - Railway URL + `/api/stripe/webhook`
   - Event: `checkout.session.completed`
   - Copy the webhook signing secret → set `STRIPE_WEBHOOK_SECRET`
4. Test card: `4242 4242 4242 4242`, any future expiry, any CVC

---

## Architecture Overview

```
Browser → Railway (Node/Express) → MongoDB Atlas
              ↓ optional integrations
         Stripe (payments)
         Cloudinary (image hosting)
         SMTP (email notifications)
         Google OAuth (social login)
         Nominatim (geocoding — free, no key needed)
```

---

## Troubleshooting

**App won't start:** Check Railway logs. Most common issue is `MONGO_URL` not set or wrong password.

**Images not persisting:** Without Cloudinary, images upload to `/uploads/` which is ephemeral on Railway. Set up Cloudinary (free tier = 25GB) for persistent images.

**Bookings not confirming via Stripe:** Make sure `STRIPE_WEBHOOK_SECRET` is set and the webhook URL is registered in Stripe Dashboard.

**Geocoding not working:** Nominatim is rate-limited. In production, consider adding a small delay between imports or use a geocoding API key.
