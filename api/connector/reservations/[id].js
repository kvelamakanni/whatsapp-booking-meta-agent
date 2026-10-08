// Meta connector tool: check_reservation_status
// GET /api/connector/reservations/:id?renter_phone=
// (renter_phone is Meta's WHATSAPP_PHONE_NUMBER macro, bound server-side)

const { isAuthorized } = require('../../../lib/auth');
const { getReservation } = require('../../../lib/reservations');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { id, renter_phone } = req.query;
  if (!renter_phone) {
    res.status(400).json({ error: 'renter_phone is required' });
    return;
  }

  try {
    const reservation = await getReservation(id, renter_phone);
    if (!reservation) {
      // Deliberately the same response whether the reference doesn't exist
      // or belongs to a different phone number — never confirm or deny
      // the existence of someone else's booking.
      res.status(404).json({ error: 'Reservation not found' });
      return;
    }
    res.status(200).json(reservation);
  } catch (e) {
    console.error('check-reservation-status error:', e);
    res.status(502).json({ error: e.message });
  }
};
