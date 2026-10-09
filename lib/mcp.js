// Direct HTTPS calls to the Kartha Hotels MCP (JSON-RPC 2.0) — no proxy hop,
// no local AI backend.
//
// Kartha's MCP mirrors the Devara contract this connector was first built
// against (totals as a [{type, amount}] array in cents, order.id on
// completion), plus a cancel_booking tool.

const MCP_URL = process.env.MCP_URL || 'https://kartha-hotel.vercel.app/api/mcp';

async function mcpCall(tool, args) {
  const payload = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name: tool, arguments: args || {} },
  };

  const headers = { 'Content-Type': 'application/json' };
  // Only sent when the shared secret is configured; Kartha enforces it once
  // MCP_API_KEY is set on its side too.
  if (process.env.MCP_API_KEY) headers['x-mcp-key'] = process.env.MCP_API_KEY;

  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const raw = await res.text();
  console.log('MCP', tool, '→', res.status, raw.slice(0, 400));

  if (!res.ok) throw new Error(`MCP ${res.status}: ${raw.slice(0, 120)}`);

  const d = JSON.parse(raw);
  if (d.error) throw new Error(`MCP error: ${JSON.stringify(d.error)}`);

  const content = d.result?.content;
  if (!content) throw new Error(`Empty MCP result for ${tool}`);

  const text = Array.isArray(content)
    ? content.map((c) => c.text ?? '').join('')
    : String(content);

  return JSON.parse(text);
}

async function searchHotels(params) {
  const data = await mcpCall('search_hotels', params);
  return Array.isArray(data) ? data : data.hotels ?? data.results ?? [];
}

async function getHotelDetails(hotelId) {
  const data = await mcpCall('get_hotel_details', { hotel_id: hotelId });
  return Array.isArray(data) ? data : data.rooms ?? data.room_types ?? data.products ?? [];
}

async function createBookingSession(params) {
  return mcpCall('create_booking_session', params);
}

async function completeBooking(params) {
  return mcpCall('complete_booking', params);
}

/** Cancels by `booking_ref` (a confirmed booking) or `session_id` (an unfinished hold). */
async function cancelBooking(params) {
  return mcpCall('cancel_booking', params);
}

module.exports = { searchHotels, getHotelDetails, createBookingSession, completeBooking, cancelBooking };
