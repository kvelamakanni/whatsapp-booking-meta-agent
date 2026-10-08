// Meta connector tool: get_hotel_details
// GET /api/connector/hotel-details?hotel_id=
//
// Without this, the agent has no legitimate way to learn a hotel's real
// room_id values before calling create_reservation — it can only see
// hotel-level results from search_hotels, which has no room data at all.

const { isAuthorized } = require('../../lib/auth');
const { getHotelDetails } = require('../../lib/mcp');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { hotel_id } = req.query;
  if (!hotel_id) {
    res.status(400).json({ error: 'hotel_id is required' });
    return;
  }

  try {
    const rooms = await getHotelDetails(hotel_id);
    const trimmed = rooms.map((r) => ({
      id: r.id,
      name: r.name ?? r.title,
      price_per_night: r.price_per_night,
      max_guests: r.max_guests,
    }));
    res.status(200).json({ hotel_id, rooms: trimmed });
  } catch (e) {
    console.error('hotel-details error:', e);
    res.status(502).json({ error: e.message });
  }
};
