// Extracted from whatsapp-vercel's lib/bookingAgent.js — the same
// destination allowlist/alias matching, kept as a small pure function here
// since this app has no conversational NLU of its own (Meta's hosted agent
// gathers the raw `destination` string; this just normalizes/defaults it
// before it reaches Devara's MCP search).

const DEFAULT_DESTINATION = 'New York';

const DESTINATION_ALIASES = {
  'new york': 'New York',
  'newyork': 'New York',
  'ny': 'New York',
  'nyc': 'New York',
  'chicago': 'Chicago',
  'los angeles': 'Los Angeles',
  'los angles': 'Los Angeles', // common typo
  'la': 'Los Angeles',
  'paris': 'Paris',
  'dubai': 'Dubai',
  'bali': 'Bali',
  'london': 'London',
};

const SUPPORTED_DESTINATIONS_LIST = ['New York', 'Chicago', 'Los Angeles', 'Paris', 'Dubai', 'Bali', 'London'];

/** Matches free text against the supported destination list; returns the canonical name or null if no match. */
function matchDestination(text) {
  const lower = String(text || '').toLowerCase();
  if (DESTINATION_ALIASES[lower]) return DESTINATION_ALIASES[lower];
  for (const [alias, canonical] of Object.entries(DESTINATION_ALIASES)) {
    if (lower.includes(alias)) return canonical;
  }
  return null;
}

/** Returns the canonical destination for a free-text city, defaulting to New York if unmatched. */
function resolveDestination(text) {
  return matchDestination(text) ?? DEFAULT_DESTINATION;
}

module.exports = { matchDestination, resolveDestination, DEFAULT_DESTINATION, SUPPORTED_DESTINATIONS_LIST };
