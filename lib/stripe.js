// Stripe (test mode) for the connector's synchronous payment step.
//
// Devara's MCP never actually charges anything — its complete_booking
// ignores the payment token — so this is the only real payment gate:
// create_reservation charges the guest's demo "saved card" inline, in the
// same request/response Meta's agent is waiting on, before the booking is
// marked complete. No Checkout redirect page exists in this app — Meta's
// connector model is a single synchronous call, not a multi-turn chat with
// a browser hop.

const Stripe = require('stripe');

let client;

// Created lazily, not at require time: a missing/invalid key should fail
// only when a payment is attempted, never take the whole endpoint down.
function stripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  if (!key.startsWith('sk_test_')) {
    throw new Error('Refusing to use a non-test Stripe key — this demo only supports sk_test_ keys');
  }
  if (!client) client = new Stripe(key);
  return client;
}

// Stripe's own test PaymentMethod token. It stands in for "a card the guest
// saved earlier" — in a real product the card would be saved on a first
// payment (setup_future_usage: 'off_session') with the guest's consent.
// Here it's attached automatically, so it's a demo shortcut.
const DEMO_SAVED_CARD = 'pm_card_visa';

/**
 * The guest's "card on file" for synchronous payment. Created once per phone
 * number (a Stripe Customer with the test card attached) and cached through
 * `store` so later reservations reuse it.
 * @returns {{ customerId: string, paymentMethodId: string, brand: string, last4: string }}
 */
async function ensureSavedCard(phone, store) {
  const existing = await store.getSavedCard(phone);
  if (existing) return existing;

  const s = stripe();
  const customer = await s.customers.create({
    description: 'Meta Business Agent reservation guest',
    metadata: { whatsapp_phone: phone },
  });
  const pm = await s.paymentMethods.attach(DEMO_SAVED_CARD, { customer: customer.id });
  const saved = {
    customerId: customer.id,
    paymentMethodId: pm.id,
    brand: pm.card.brand,
    last4: pm.card.last4,
  };
  await store.setSavedCard(phone, saved);
  return saved;
}

/**
 * Charges the saved card off-session, in one call. The idempotency key is
 * per reservation, so a retried create_reservation request can never charge
 * the same booking twice — mirrors the idempotency Meta's docs require of
 * the backend for write operations.
 */
async function chargeSavedCard({ saved, amountCents, currency = 'usd', description, phone, idempotencyKey }) {
  return stripe().paymentIntents.create(
    {
      amount: amountCents,
      currency: currency.toLowerCase(),
      customer: saved.customerId,
      payment_method: saved.paymentMethodId,
      off_session: true,
      confirm: true,
      description,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: { phone },
    },
    { idempotencyKey: `pi_${idempotencyKey}` },
  );
}

// Keyed per PaymentIntent, so a retried cancel/rollback can never refund the
// same charge twice.
async function refundPayment(paymentIntentId) {
  return stripe().refunds.create(
    { payment_intent: paymentIntentId },
    { idempotencyKey: `refund_${paymentIntentId}` },
  );
}

module.exports = { ensureSavedCard, chargeSavedCard, refundPayment };
