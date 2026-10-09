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
const { ensureSavedCard, chargeSavedCard } = require('./stripe');

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

module.exports = { createReservation, getReservation };
