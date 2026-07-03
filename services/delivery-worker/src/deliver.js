import { request } from 'undici';
import { config } from '@relay/lib/config.js';
import { sign, formatSignatureHeader } from './signer.js';

const MAX_SNIPPET_LENGTH = 500;

export async function deliver(destination, message) {
  const body = JSON.stringify(message);
  const timestamp = Math.floor(Date.now() / 1000);
  const secret = destination.secret || config.DELIVERY_HMAC_SECRET;
  const hexSig = sign(body, secret, timestamp);
  const signatureHeader = formatSignatureHeader(timestamp, hexSig);

  const { statusCode, body: resBody } = await request(destination.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Relay-Signature': signatureHeader,
      'X-Relay-Timestamp': String(timestamp),
      'X-Relay-Event-Id': message.event_id,
      'User-Agent': 'Relay-Delivery-Worker/1.0',
    },
    body,
  });

  let snippet = '';
  try {
    snippet = await resBody.text();
    if (snippet.length > MAX_SNIPPET_LENGTH) {
      snippet = snippet.slice(0, MAX_SNIPPET_LENGTH);
    }
  } catch {
    /* response body not available */
  }

  return { statusCode, responseBodySnippet: snippet };
}
