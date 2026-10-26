// Page the guest sees in the browser after Stripe Checkout. Display only: the
// booking is completed by the Stripe webhook, never by this page.

module.exports = (req, res) => {
  const cancelled = req.query && req.query.cancelled;
  const title = cancelled ? 'Payment not completed' : 'Payment received';
  const body = cancelled
    ? 'No charge was made. Return to WhatsApp to try again or ask for a new payment link.'
    : 'Thank you. Your confirmation is on its way in WhatsApp. You can close this page and return to the chat.';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f6f6f4;color:#111}
main{max-width:360px;padding:24px;text-align:center}h1{font-size:20px;font-weight:500}p{color:#555;line-height:1.5}</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`);
};
