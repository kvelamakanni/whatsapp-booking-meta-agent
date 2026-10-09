// Meta connector tool: create_reservation
// POST /api/connector/reservations
// Body: { hotel_id, room_id, check_in, check_out, guests, driver_phone }
// (driver_phone is Meta's WHATSAPP_PHONE_NUMBER macro, bound server-side —
// never trust a phone number the agent might pass any other way)

const { isAuthorized } = require('../../lib/auth');
const { createReservation } = require('../../lib/reservations');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { hotel_id, room_id, check_in, check_out, guests, driver_phone } = req.body || {};
  if (!hotel_id || !room_id || !check_in || !check_out || !driver_phone) {
    res.status(400).json({ error: 'hotel_id, room_id, check_in, check_out and driver_phone are all required' });
    return;
  }

  try {
    const result = await createReservation({
      phone: driver_phone,
      hotelId: hotel_id,
      roomId: room_id,
      checkIn: check_in,
      checkOut: check_out,
      guests: guests ? parseInt(guests, 10) : 1,
    });

    if (result.status === 'failed') {
      // 402 only for a declined payment; a booking that failed after a
      // (refunded) charge is a server-side problem.
      res.status(/^Payment failed/.test(result.error) ? 402 : 502).json({ error: result.error });
      return;
    }

    res.status(201).json(result);
  } catch (e) {
    console.error('create-reservation error:', e);
    if (/No (hotel|room) matching/i.test(e.message)) {
      res.status(404).json({
        error: 'Hotel or room not found. Use the hotel_id from search_hotels and a room_id from get_hotel_details.',
      });
      return;
    }
    res.status(502).json({ error: e.message });
  }
};
