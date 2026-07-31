const express = require('express');
const db = require('../db/db');
const { requireAuth, requireCharacter } = require('../middleware');
const { CROWN_PACKAGES, adjustCrowns } = require('../crowns');

const router = express.Router();

// Lazily constructed - if STRIPE_SECRET_KEY isn't set yet (e.g. this deploy hasn't been
// given real keys), routes that need it fail with a clear "not configured" error instead
// of crashing the whole server at startup.
function getStripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  const Stripe = require('stripe');
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

router.get('/packages', requireAuth, (req, res) => {
  res.json({ packages: CROWN_PACKAGES.map((p, i) => ({ index: i, crowns: p.crowns, priceUsdCents: p.priceUsdCents })) });
});

router.get('/balance', requireAuth, requireCharacter, (req, res) => {
  const recent = db.prepare('SELECT amount, reason, created_at FROM crown_transactions WHERE character_id = ? ORDER BY id DESC LIMIT 20').all(req.character.id);
  res.json({ balance: req.character.crowns_balance, recentTransactions: recent });
});

// Creates a Stripe Checkout Session for a Crown package - the character ID rides along as
// client_reference_id so the webhook (which has no session/auth context of its own, since
// Stripe calls it directly) knows who to credit once payment actually clears.
router.post('/checkout', requireAuth, requireCharacter, async (req, res) => {
  const stripe = getStripeClient();
  if (!stripe) {
    return res.status(503).json({ error: 'Crown purchases are not yet configured on this server.' });
  }
  const { packageIndex } = req.body;
  const pkg = CROWN_PACKAGES[packageIndex];
  if (!pkg) {
    return res.status(400).json({ error: 'Invalid package.' });
  }

  try {
    const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      client_reference_id: String(req.character.id),
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `${pkg.crowns} Crowns` },
          unit_amount: pkg.priceUsdCents,
        },
        quantity: 1,
      }],
      metadata: { characterId: String(req.character.id), crowns: String(pkg.crowns) },
      success_url: `${origin}/?crowns=success`,
      cancel_url: `${origin}/?crowns=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout session creation failed:', err);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// Stripe calls this directly (no cookies, no session) once a payment actually clears -
// this is the ONLY place Crowns get credited from a real purchase, never the client-side
// success redirect, which could be reached without ever actually paying.
//
// IMPORTANT: this must be mounted in index.js BEFORE the global express.json() middleware,
// with its own express.raw() applied first - Stripe's signature verification needs the
// exact raw request bytes, and express.json() would otherwise have already consumed and
// parsed the body before this handler ever saw it, at which point the raw bytes are gone.
// See index.js for where this actually gets wired in.
function handleStripeWebhook(req, res) {
  const stripe = getStripeClient();
  if (!stripe) {
    return res.status(503).send('Not configured.');
  }

  let event;
  try {
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const characterId = Number(session.metadata?.characterId || session.client_reference_id);
    const crowns = Number(session.metadata?.crowns);
    if (characterId && crowns) {
      const character = db.prepare('SELECT id FROM characters WHERE id = ?').get(characterId);
      if (character) {
        adjustCrowns(characterId, crowns, 'stripe_purchase', session.id);
      }
    }
  }

  res.json({ received: true });
}

module.exports = router;
module.exports.handleStripeWebhook = handleStripeWebhook;
