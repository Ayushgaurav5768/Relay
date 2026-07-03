import { request } from 'undici';
import { config } from '@relay/lib/config.js';
import { deliveryAttemptDurationSeconds } from '@relay/lib/metrics.js';
import { sign, formatSignatureHeader } from './signer.js';

const MAX_SNIPPET_LENGTH = 500;

export async function deliver(destination, message) {
  const body = JSON.stringify(message);
  const timestamp = Math.floor(Date.now() / 1000);
  const secret = destination.secret || config.DELIVERY_HMAC_SECRET;
  const hexSig = sign(body, secret, timestamp);
  const signatureHeader = formatSignatureHeader(timestamp, hexSig);

  const start = Date.now();
  let statusCode;
  try {
    const { statusCode: sc, body: resBody } = await request(destination.url, {
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
    statusCode = sc;

    const status = (sc >= 200 && sc < 300) ? 'success' : 'failure';
    deliveryAttemptDurationSeconds.observe(
      { destination_id: destination.id, status },
      (Date.now() - start) / 1000,
    );

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
  } catch (err) {
    deliveryAttemptDurationSeconds.observe(
      { destination_id: destination.id, status: 'error' },
      (Date.now() - start) / 1000,
    );
    throw err;
  }
}
