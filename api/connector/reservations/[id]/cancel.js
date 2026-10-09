// Meta connector tool: cancel_reservation
// POST /api/connector/reservations/:id/cancel?renter_phone=
// (renter_phone is Meta's WHATSAPP_PHONE_NUMBER macro, bound server-side)

const { isAuthorized } = require('../../../../lib/auth');
const { cancelReservation } = require('../../../../lib/reservations');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { id } = req.query;
  const renterPhone = req.query.renter_phone ?? req.body?.renter_phone;
  if (!renterPhone) {
    res.status(400).json({ error: 'renter_phone is required' });
    return;
  }

  try {
    const result = await cancelReservation(id, renterPhone);

    switch (result.status) {
      case 'not_found':
        // Same answer for "doesn't exist" and "belongs to another phone".
        res.status(404).json({ error: 'Reservation not found' });
        return;
      case 'already_cancelled':
        res.status(409).json({ error: 'Reservation is already cancelled', reservation: result.record });
        return;
      case 'unsupported':
        res.status(422).json({ error: result.error });
        return;
      case 'failed':
        res.status(502).json({ error: result.error });
        return;
      default:
        if (result.refund === 'failed') {
          res.status(502).json({
            error: 'The reservation was cancelled, but the automatic refund failed — please contact support.',
            reservation: result.record,
          });
          return;
        }
        res.status(200).json(result.record);
    }
  } catch (e) {
    console.error('cancel-reservation error:', e);
    res.status(502).json({ error: e.message });
  }
};
