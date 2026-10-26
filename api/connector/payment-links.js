// Meta connector tool: create_payment_link
// POST /api/connector/payment-links
// Body: { hotel_id, room_id, check_in, check_out, guests, customer_phone }
// (customer_phone is Meta's WHATSAPP_PHONE_NUMBER macro, bound server-side)
// Holds the room and returns a Stripe Checkout URL for the agent's "Pay now" button.

const { isAuthorized } = require('../../lib/auth');
const { createPaymentLink } = require('../../lib/reservations');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { hotel_id, room_id, check_in, check_out, guests, customer_phone } = req.body || {};
  if (!hotel_id || !room_id || !check_in || !check_out || !customer_phone) {
    res.status(400).json({ error: 'hotel_id, room_id, check_in, check_out and customer_phone are all required' });
    return;
  }

  try {
    const result = await createPaymentLink({
      phone: customer_phone,
      hotelId: hotel_id,
      roomId: room_id,
      checkIn: check_in,
      checkOut: check_out,
      guests: guests ? parseInt(guests, 10) : 1,
    });
    res.status(201).json(result);
  } catch (e) {
    console.error('create-payment-link error:', e);
    res.status(502).json({ error: e.message });
  }
};
