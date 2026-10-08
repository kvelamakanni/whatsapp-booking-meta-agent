// Validates the X-API-Key header Meta's connector sends on every tool call
// (configured as auth_type: API_KEY, auth_config.api_key, when the
// connector is registered with Meta — see the plan's registration step).

const CONNECTOR_API_KEY = process.env.CONNECTOR_API_KEY;

/**
 * Returns true if the request is authorized. Callers should check this
 * first, before touching any other logic, and respond 401 immediately if
 * it returns false.
 */
function isAuthorized(req) {
  if (!CONNECTOR_API_KEY) {
    console.error('CONNECTOR_API_KEY is not set — refusing all requests');
    return false;
  }
  const provided = req.headers['x-api-key'];
  return provided === CONNECTOR_API_KEY;
}

module.exports = { isAuthorized };
