// Short link for the Pay now button: /api/pay/KV-XXXXXXXX redirects to the
// Stripe Checkout page. Stripe's own URLs are far too long for a WhatsApp
// button, so the agent is given this short address instead.

const { getPaymentRedirect } = require('../../lib/reservations');

function page(res, status, title, text) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(status).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f6f6f4;color:#111}main{max-width:360px;padding:24px;text-align:center}h1{font-size:20px;font-weight:500}p{color:#555;line-height:1.5}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`);
}

module.exports = async (req, res) => {
  try {
    const result = await getPaymentRedirect(String(req.query.ref || ''));
    if (result.url) {
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, result.url);
    } else if (result.status === 'confirmed') {
      page(res, 200, 'Already paid', 'This booking is already paid and confirmed. You can return to WhatsApp.');
    } else {
      page(res, 410, 'Link no longer valid', 'This payment link has expired or does not exist. Return to WhatsApp and ask for a new one.');
    }
  } catch (e) {
    console.error('pay redirect error:', e);
    page(res, 502, 'Something went wrong', 'Please return to WhatsApp and try again.');
  }
};
