// Redis-backed reservation records: idempotency for create_reservation, and
// phone-number binding for check_reservation_status / cancel_reservation —
// the backend responsibilities Meta's connector docs explicitly require
// ("enforce uniqueness on your backend... return the existing booking
// reference when the same request arrives twice", and "reject a booking
// reference that does not belong to the bound number"). Connection pattern
// (lazy client, per-call timeout) ported from whatsapp-vercel's lib/session.js.

const { Redis } = require('@upstash/redis');
const kv = Redis.fromEnv();

const { createBookingSession, completeBooking, cancelBooking } = require('./mcp');
const { ensureSavedCard, chargeSavedCard, refundPayment } = require('./stripe');

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

// The hotel system generates its own booking reference with its own prefix
// (e.g. "BK-"), which gets replaced with a consistent "KV-" reference
// regardless of what the upstream provider used.
function toReference(mcpOrderId) {
  return mcpOrderId
    ? `KV-${mcpOrderId.replace(/^[A-Za-z]+-/, '')}`
    : `KV-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

// Best effort: free an unfinished hold in the hotel system so a failed
// attempt doesn't leave a dangling "incomplete" session behind.
async function releaseHold(sessionId) {
  try {
    await cancelBooking({ session_id: sessionId });
  } catch (e) {
    console.error('Could not release held session', sessionId, e.message);
  }
}

/**
 * Creates (or returns the existing, idempotent) reservation: holds the room
 * in the hotel system, charges the guest's saved card synchronously, and
 * completes the booking — all within this one call, matching Meta's
 * create_reservation contract (single request/response, no multi-turn chat).
 * If anything fails after money is taken, the charge is refunded.
 */
async function createReservation({ phone, hotelId, roomId, checkIn, checkOut, guests }) {
  const idemKey = idempotencyKey(phone, hotelId, roomId, checkIn, checkOut);

  const existingRef = await withTimeout(kv.get(idemKey), 'getIdempotency');
  if (existingRef) {
    const existing = await withTimeout(kv.get(reservationKey(existingRef)), 'getReservation(idempotent)');
    if (existing && existing.status !== 'cancelled') return existing;
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

  // totals is a [{ type, amount }] array with amounts in cents.
  const totals = bookingSession.totals;
  const totalCents = Array.isArray(totals) ? totals.find((t) => t.type === 'total')?.amount : undefined;
  const currency = bookingSession.currency ?? 'USD';
  if (!Number.isInteger(totalCents) || totalCents <= 0) {
    await releaseHold(sessionId);
    throw new Error('Could not read the booking total from the hotel system');
  }

  let saved;
  try {
    saved = await ensureSavedCard(phone, cardStore);
  } catch (e) {
    await releaseHold(sessionId);
    throw e;
  }

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
    await releaseHold(sessionId);
    return { status: 'failed', error: `Payment failed: ${e.message}` };
  }

  let completed;
  try {
    completed = await completeBooking({ session_id: sessionId, payment_token: 'success_token' });
  } catch (e) {
    // The card was charged but the booking didn't complete: give the money back.
    let refunded = true;
    try {
      await refundPayment(charge.id);
    } catch (refundErr) {
      refunded = false;
      console.error('REFUND FAILED — needs manual refund of', charge.id, refundErr.message);
    }
    await releaseHold(sessionId);
    return {
      status: 'failed',
      error: refunded
        ? `The booking could not be completed, so your card was refunded. (${e.message})`
        : `The booking could not be completed and the automatic refund failed — please contact support. (${e.message})`,
    };
  }

  const mcpBookingRef = completed.booking_ref ?? completed.order?.id;
  const reference = toReference(completed.order?.id ?? mcpBookingRef);

  const record = {
    reference,
    status: 'confirmed',
    phone,
    hotelId,
    roomId,
    checkIn,
    checkOut,
    guests,
    total: (totalCents / 100).toFixed(2),
    currency,
    paymentIntentId: charge.id,
    mcpBookingRef,
  };

  await withTimeout(kv.set(reservationKey(reference), record, { ex: RESERVATION_TTL_SECONDS }), 'setReservation');
  await withTimeout(kv.set(idemKey, reference, { ex: IDEMPOTENCY_TTL_SECONDS }), 'setIdempotency');

  return record;
}

/**
 * Looks up a reservation, but only returns it if `phone` matches the phone
 * number it was created under — the exact pattern Meta's docs call for:
 * "reject a booking reference that does not belong to the bound number
 * rather than trusting whatever reference was typed into the chat."
 * Returns null for both "not found" and "wrong phone", so a caller can't
 * distinguish the two and probe for someone else's reference.
 */
async function getReservation(reference, phone) {
  const record = await withTimeout(kv.get(reservationKey(reference)), 'getReservation');
  if (!record || record.phone !== phone) return null;
  return record;
}

/**
 * Cancels a confirmed reservation (phone-bound, like getReservation): cancels
 * the booking in the hotel system, then refunds the Stripe charge.
 * Returns { status: 'not_found' | 'already_cancelled' | 'unsupported' |
 * 'failed' | 'cancelled', ... }.
 */
async function cancelReservation(reference, phone) {
  const record = await getReservation(reference, phone);
  if (!record) return { status: 'not_found' };
  if (record.status === 'cancelled') return { status: 'already_cancelled', record };
  if (!record.mcpBookingRef) {
    return { status: 'unsupported', error: 'This older reservation cannot be cancelled automatically — please contact support.' };
  }

  try {
    await cancelBooking({ booking_ref: record.mcpBookingRef });
  } catch (e) {
    // Already cancelled on the hotel side (e.g. via its own site): still refund below.
    if (!/already cancelled/i.test(e.message)) {
      return { status: 'failed', error: `Could not cancel the booking: ${e.message}` };
    }
  }

  let refund = 'issued';
  let refundError;
  if (record.paymentIntentId) {
    try {
      await refundPayment(record.paymentIntentId);
    } catch (e) {
      refund = 'failed';
      refundError = e.message;
      console.error('REFUND FAILED — needs manual refund of', record.paymentIntentId, e.message);
    }
  }

  const updated = { ...record, status: 'cancelled', cancelledAt: new Date().toISOString(), refund };
  await withTimeout(kv.set(reservationKey(reference), updated, { ex: RESERVATION_TTL_SECONDS }), 'setReservation(cancelled)');
  // Free the dedupe key so the same guest can book the same room/dates again.
  await withTimeout(
    kv.del(idempotencyKey(record.phone, record.hotelId, record.roomId, record.checkIn, record.checkOut)),
    'clearIdempotency',
  );

  return { status: 'cancelled', record: updated, refund, ...(refundError ? { error: refundError } : {}) };
}

module.exports = { createReservation, getReservation, cancelReservation };
