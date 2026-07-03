import { config } from '@relay/lib/config.js';
import { createLogger } from '@relay/lib/logger.js';

const log = createLogger({ service: 'ingest' });

const API_KEYS = new Map();
if (config.INGEST_API_KEYS) {
  config.INGEST_API_KEYS.split(',').filter(Boolean).forEach((pair) => {
    const [ownerId, ...rest] = pair.split(':');
    const apiKey = rest.join(':');
    if (ownerId && apiKey) {
      API_KEYS.set(apiKey, ownerId);
    }
  });
}

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) {
    res.status(401).json({ error: 'missing or invalid authorization header' });
    return;
  }

  try {
    const base64 = header.slice(6);
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    const colonIndex = decoded.indexOf(':');
    const apiKey = colonIndex === -1 ? decoded : decoded.slice(0, colonIndex);

    const ownerId = API_KEYS.get(apiKey);
    if (!ownerId) {
      res.status(401).json({ error: 'invalid API key' });
      return;
    }

    req.api_key = apiKey;
    req.owner_id = ownerId;
    next();
  } catch (err) {
    log.warn({ err }, 'failed to parse auth header');
    res.status(401).json({ error: 'invalid authorization header' });
  }
}
