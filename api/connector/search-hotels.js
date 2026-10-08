// Meta connector tool: search_hotels
// GET /api/connector/search-hotels?destination=&check_in=&check_out=&guests=

const { isAuthorized } = require('../../lib/auth');
const { resolveDestination } = require('../../lib/destinations');
const { searchHotels } = require('../../lib/mcp');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { destination, check_in, check_out, guests } = req.query;
  if (!destination || !check_in || !check_out || !guests) {
    res.status(400).json({ error: 'destination, check_in, check_out and guests are all required' });
    return;
  }

  try {
    const resolvedDestination = resolveDestination(destination);
    const hotels = await searchHotels({
      destination: resolvedDestination,
      check_in,
      check_out,
      guests: parseInt(guests, 10),
    });

    // Keep the response small — only what the agent needs to present
    // options and let the guest pick, per Meta's "return only available
    // classes with pricing, not the full fleet" guidance.
    const trimmed = hotels.map((h) => ({
      id: h.id,
      name: h.name,
      star_rating: h.star_rating,
      price_per_night: h.price_per_night,
      currency: h.currency,
    }));

    res.status(200).json({ destination: resolvedDestination, hotels: trimmed });
  } catch (e) {
    console.error('search-hotels error:', e);
    res.status(502).json({ error: e.message });
  }
};
