// Redis-backed reservation records: idempotency for create_reservation, and
// phone-number binding for check_reservation_status — the two backend
// responsibilities Meta's connector docs explicitly require ("enforce
// uniqueness on your backend... return the existing booking reference when
// the same request arrives twice", and "reject a booking reference that
// does not belong to the bound number"). Connection pattern (lazy client,
// per-call timeout) ported from whatsapp-vercel's lib/session.js.

const { Redis } = require('@upstash/redis');
const kv = Redis.fromEnv();

const { createBookingSession, completeBooking } = require('./mcp');
const {
  ensureSavedCard,
  chargeSavedCard,
  refundPayment,
  createCheckoutSession,
  getCheckoutSession,
} = require('./stripe');
const whatsapp = require('./whatsapp');

const RESERVATION_TTL_SECONDS = 60 * 60 * 24 * 7; // keep a completed reservation's record for 7 days
const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24; // how long a retried create_reservation is still deduped
const SAVED_CARD_TTL_SECONDS = 60 * 60 * 24 * 30; // demo "card on file" is kept for 30 days
const REDIS_CALL_TIMEOUT_MS = 5000; // fail fast with a clear error instead of hanging until Vercel's own timeout

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Redis call timed out after ${REDIS_CALL_TIMEOUT_MS}ms: ${label}`)), REDIS_CALL_TIMEOUT_MS),
    ),
  ]);
}

function reservationKey(reference) {
  return `reservation:${reference}`;
}

function idempotencyKey(phone, hotelId, roomId, checkIn, checkOut) {
  return `idem:${phone}:${hotelId}:${roomId}:${checkIn}:${checkOut}`;
}

function savedCardKey(phone) {
  return `card:${phone}`;
}

// The `store` shape lib/stripe.js's ensureSavedCard() expects.
const cardStore = {
  async getSavedCard(phone) {
    return withTimeout(kv.get(savedCardKey(phone)), 'getSavedCard');
  },
  async setSavedCard(phone, card) {
    await withTimeout(kv.set(savedCardKey(phone), card, { ex: SAVED_CARD_TTL_SECONDS }), 'setSavedCard');
  },
};

// Same prefix-normalization as whatsapp-vercel's bookingAgent.js: the
// external MCP generates its own order id with its own prefix (e.g. "BK-"),
// which gets replaced with a consistent "KV-" reference regardless of what
// the upstream provider used.
function toReference(mcpOrderId) {
  return mcpOrderId
    ? `KV-${mcpOrderId.replace(/^[A-Za-z]+-/, '')}`
    : `KV-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/**
 * Creates (or returns the existing, idempotent) reservation: holds the room
 * via Devara's MCP, charges the guest's saved card synchronously, and
 * completes the MCP booking — all within this one call, matching Meta's
 * create_reservation contract (single request/response, no multi-turn chat).
 */
async function createReservation({ phone, hotelId, roomId, checkIn, checkOut, guests }) {
  const idemKey = idempotencyKey(phone, hotelId, roomId, checkIn, checkOut);

  const existingRef = await withTimeout(kv.get(idemKey), 'getIdempotency');
  if (existingRef) {
    const existing = await withTimeout(kv.get(reservationKey(existingRef)), 'getReservation(idempotent)');
    if (existing) return existing;
  }

  const bookingSession = await createBookingSession({
    hotel_id: hotelId,
    room_id: roomId,
    check_in: checkIn,
    check_out: checkOut,
    guests,
  });
  const sessionId = bookingSession.id ?? bookingSession.session_id;
  if (!sessionId) throw new Error('No session ID from MCP: ' + JSON.stringify(bookingSession).slice(0, 200));

  // totals[].amount from create_booking_session is in cents (confirmed
  // against the live MCP: amount: 87136 === $871.36).
  const totalCents = bookingSession.totals?.find((t) => t.type === 'total')?.amount;
  const currency = bookingSession.currency ?? 'USD';

  const saved = await ensureSavedCard(phone, cardStore);

  let charge;
  try {
    charge = await chargeSavedCard({
      saved,
      amountCents: totalCents,
      currency,
      description: `Hotel reservation ${sessionId}`,
      phone,
      idempotencyKey: sessionId,
    });
  } catch (e) {
    return { status: 'failed', error: `Payment failed: ${e.message}` };
  }

  const completed = await completeBooking({ session_id: sessionId, payment_token: 'success_token' });
  const reference = toReference(completed.order?.id);
  const totalDollars = totalCents != null ? (totalCents / 100).toFixed(2) : null;

  const record = {
    reference,
    status: 'confirmed',
    phone,
    hotelId,
    roomId,
    checkIn,
    checkOut,
    guests,
    total: totalDollars,
    currency,
    paymentIntentId: charge.id,
  };

  await withTimeout(kv.set(reservationKey(reference), record, { ex: RESERVATION_TTL_SECONDS }), 'setReservation');
  await withTimeout(kv.set(idemKey, reference, { ex: IDEMPOTENCY_TTL_SECONDS }), 'setIdempotency');

  return record;
}

function digits(phone) {
  return String(phone ?? '').replace(/\D/g, '');
}

function linkIdempotencyKey(phone, hotelId, roomId, checkIn, checkOut) {
  return `idemlink:${phone}:${hotelId}:${roomId}:${checkIn}:${checkOut}`;
}

function baseUrl() {
  const url = process.env.PUBLIC_BASE_URL;
  if (!url) throw new Error('PUBLIC_BASE_URL is not set');
  return url.replace(/\/$/, '');
}

async function saveRecord(record) {
  await withTimeout(kv.set(reservationKey(record.reference), record, { ex: RESERVATION_TTL_SECONDS }), 'setReservation');
}

async function loadRecord(reference) {
  return withTimeout(kv.get(reservationKey(reference)), 'getReservation');
}

// Fields the agent/guest may see; internal ids stay server-side.
function publicView(record) {
  const { checkoutSessionId, mcpSessionId, paymentIntentId, mcpBookingRef, ...rest } = record;
  if (record.status === 'awaiting_payment') {
    rest.next_step =
      'The booking is not paid yet. Send the guest a Pay now button that opens payment_url, with the text "Tap below to complete your payment." Do not say the booking is confirmed.';
  } else if (record.status === 'expired') {
    rest.next_step = 'The payment link expired. Offer to create a new payment link.';
  } else if (record.status === 'failed') {
    rest.next_step = 'Payment was refunded because the room could not be booked. Offer other rooms or dates.';
  }
  return rest;
}

/**
 * Payment-link flow, step 1: hold the room and create a Stripe Checkout page.
 * Idempotent per phone+hotel+room+dates while a link is still live or the
 * booking is confirmed; expired/failed ones are replaced by a fresh link.
 */
async function createPaymentLink({ phone: rawPhone, hotelId, roomId, checkIn, checkOut, guests }) {
  const phone = digits(rawPhone);
  const idemKey = linkIdempotencyKey(phone, hotelId, roomId, checkIn, checkOut);

  const existingRef = await withTimeout(kv.get(idemKey), 'getLinkIdempotency');
  if (existingRef) {
    const refreshed = await finalizeReservation(existingRef);
    if (refreshed && (refreshed.status === 'awaiting_payment' || refreshed.status === 'confirmed')) {
      return publicView(refreshed);
    }
  }

  const bookingSession = await createBookingSession({
    hotel_id: hotelId,
    room_id: roomId,
    check_in: checkIn,
    check_out: checkOut,
    guests,
  });
  const sessionId = bookingSession.id ?? bookingSession.session_id;
  if (!sessionId) throw new Error('No session ID from MCP: ' + JSON.stringify(bookingSession).slice(0, 200));

  const totals = Array.isArray(bookingSession.totals) ? bookingSession.totals : [];
  const totalCents = totals.find((t) => t.type === 'total')?.amount;
  if (!Number.isInteger(totalCents) || totalCents <= 0) {
    throw new Error('MCP returned no usable total for the booking session');
  }
  const currency = bookingSession.currency ?? 'USD';

  const reference = `KV-${String(sessionId).replace(/[^A-Za-z0-9]/g, '').slice(-8).toUpperCase()}`;

  const checkout = await createCheckoutSession({
    amountCents: totalCents,
    currency,
    description: `Hotel reservation ${reference}`,
    reference,
    successUrl: `${baseUrl()}/api/payment-return`,
    cancelUrl: `${baseUrl()}/api/payment-return?cancelled=1`,
  });

  const record = {
    reference,
    status: 'awaiting_payment',
    phone,
    hotelId,
    roomId,
    checkIn,
    checkOut,
    guests,
    total: (totalCents / 100).toFixed(2),
    currency,
    payment_url: checkout.url,
    expires_at: new Date(checkout.expires_at * 1000).toISOString(),
    mcpSessionId: sessionId,
    checkoutSessionId: checkout.id,
  };

  await saveRecord(record);
  await withTimeout(kv.set(idemKey, reference, { ex: IDEMPOTENCY_TTL_SECONDS }), 'setLinkIdempotency');
  return publicView(record);
}

/**
 * Payment-link flow, step 2: ask Stripe whether the guest has paid and, if so,
 * complete the hotel booking exactly once. Safe to call from the Stripe
 * webhook, the status check, or both at the same time.
 */
async function finalizeReservation(reference) {
  const record = await loadRecord(reference);
  if (!record) return null;
  if (record.status === 'confirmed' || record.status === 'failed') return record;
  if (!record.checkoutSessionId) return record;

  const cs = await getCheckoutSession(record.checkoutSessionId);

  if (cs.payment_status !== 'paid') {
    if (cs.status === 'expired' && record.status !== 'expired') {
      const expired = { ...record, status: 'expired' };
      await saveRecord(expired);
      return expired;
    }
    return record;
  }

  const acquired = await withTimeout(
    kv.set(`finalize:${reference}`, '1', { nx: true, ex: 120 }),
    'finalizeLock',
  );
  if (!acquired) return (await loadRecord(reference)) ?? record;

  const paymentIntentId = typeof cs.payment_intent === 'string' ? cs.payment_intent : cs.payment_intent?.id;

  try {
    const completed = await completeBooking({ session_id: record.mcpSessionId, payment_token: 'success_token' });
    const confirmed = {
      ...record,
      status: 'confirmed',
      mcpBookingRef: completed.order?.id ?? null,
      paymentIntentId,
      paidAt: new Date().toISOString(),
    };
    delete confirmed.payment_url;
    await saveRecord(confirmed);
    return confirmed;
  } catch (e) {
    console.error('finalize: hotel booking failed after payment, refunding', reference, e.message);
    let refunded = false;
    try {
      if (paymentIntentId) {
        await refundPayment(paymentIntentId);
        refunded = true;
      }
    } catch (re) {
      console.error('finalize: refund failed', reference, re.message);
    }
    const failed = {
      ...record,
      status: 'failed',
      error: refunded
        ? 'The room could not be booked after payment. The payment has been refunded.'
        : 'The room could not be booked after payment. A refund is pending.',
      paymentIntentId,
    };
    delete failed.payment_url;
    await saveRecord(failed);
    return failed;
  }
}

/**
 * Sends the guest the confirmation over the Cloud API once, then hands the
 * chat back to the Meta agent. Booking state never depends on this succeeding;
 * on failure the guard is cleared so a Stripe retry can try again.
 */
async function sendConfirmationOnce(record) {
  if (!record || record.status !== 'confirmed' || !whatsapp.configured()) return false;

  const guardKey = `confirmation_sent:${record.reference}`;
  const acquired = await withTimeout(kv.set(guardKey, '1', { nx: true, ex: RESERVATION_TTL_SECONDS }), 'confirmationGuard');
  if (!acquired) return false;

  try {
    await whatsapp.sendText(
      record.phone,
      `Payment received. Your booking is confirmed: ${record.reference}, ${record.checkIn} to ${record.checkOut}, ${record.currency} ${record.total} paid.`,
    );
  } catch (e) {
    console.error('confirmation send failed', record.reference, e.message);
    await withTimeout(kv.del(guardKey), 'clearConfirmationGuard').catch(() => {});
    return false;
  }

  // Meta may not have assigned the thread to us the instant the send returns,
  // so retry the release a few times before giving up.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await new Promise((r) => setTimeout(r, attempt * 1200));
      await whatsapp.releaseThread(record.phone);
      console.log('thread released', record.reference, 'attempt', attempt);
      break;
    } catch (e) {
      console.error('thread release failed', record.reference, 'attempt', attempt, e.message);
    }
  }
  return true;
}

async function markExpired(reference) {
  const record = await loadRecord(reference);
  if (record && record.status === 'awaiting_payment') {
    await saveRecord({ ...record, status: 'expired' });
  }
}

/**
 * Looks up a reservation, but only returns it if `phone` matches the phone
 * number it was created under — the exact pattern Meta's docs call for:
 * "reject a booking reference that does not belong to the bound number
 * rather than trusting whatever reference was typed into the chat."
 * Returns null for both "not found" and "wrong phone", so a caller can't
 * distinguish the two and probe for someone else's reference. A reservation
 * still awaiting payment is checked against Stripe first, so the answer is
 * right even if the webhook was missed.
 */
async function getReservation(reference, phone) {
  reference = String(reference).toUpperCase();
  let record = await loadRecord(reference);
  if (!record || digits(record.phone) !== digits(phone)) return null;
  if (record.status === 'awaiting_payment') {
    try {
      record = (await finalizeReservation(reference)) ?? record;
    } catch (e) {
      console.error('lazy finalize failed', reference, e.message);
    }
  }
  return publicView(record);
}

module.exports = {
  createReservation,
  createPaymentLink,
  finalizeReservation,
  sendConfirmationOnce,
  markExpired,
  getReservation,
};
