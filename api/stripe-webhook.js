// Stripe -> connector. Public route (no X-API-Key): authenticity comes from
// the Stripe signature. The payload is never trusted for what was booked; it
// only supplies our own reference, and everything else is read from Redis.

const { constructWebhookEvent } = require('../lib/stripe');
const { finalizeReservation, sendConfirmationOnce, markExpired } = require('../lib/reservations');

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let event;
  try {
    const raw = await readRawBody(req);
    event = constructWebhookEvent(raw, req.headers['stripe-signature']);
  } catch (e) {
    console.error('stripe-webhook: signature check failed:', e.message);
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  const session = event.data?.object;
  const reference = session?.metadata?.reference;

  try {
    if (
      reference &&
      (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded')
    ) {
      let record = await finalizeReservation(reference);
      // Another caller (status check, parallel delivery) may hold the finalize
      // lock; wait for it, and if it never settles let Stripe retry.
      const claimsPaid = session.payment_status === 'paid';
      for (let i = 0; claimsPaid && i < 6 && record?.status === 'awaiting_payment'; i++) {
        await new Promise((r) => setTimeout(r, 400));
        record = await finalizeReservation(reference);
      }
      console.log('stripe-webhook: finalized', reference, record?.status);
      if (claimsPaid && record?.status === 'awaiting_payment') throw new Error('Payment is paid but booking is not settled yet');
      if (record?.status === 'confirmed') await sendConfirmationOnce(record);
    } else if (reference && event.type === 'checkout.session.expired') {
      await markExpired(reference);
    }
    res.status(200).json({ received: true });
  } catch (e) {
    // 500 makes Stripe retry; finalize and the confirmation guard are idempotent.
    console.error('stripe-webhook error:', e);
    res.status(500).json({ error: e.message });
  }
};

module.exports.config = { api: { bodyParser: false } };
