import crypto from 'crypto';

const TOLERANCE_SEC = 300;

export function sign(payload, secret, timestamp) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${timestamp}.${payload}`);
  return hmac.digest('hex');
}

export function parseSignatureHeader(header) {
  const entries = {};
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    entries[part.slice(0, idx)] = part.slice(idx + 1);
  }
  const timestamp = parseInt(entries.t, 10);
  const signature = entries.v1;
  if (isNaN(timestamp) || !signature) return null;
  return { timestamp, signature };
}

export function formatSignatureHeader(timestamp, hexSig) {
  return `t=${timestamp},v1=${hexSig}`;
}

export function verifySignature(rawBody, signatureHeader, secret, toleranceSec = TOLERANCE_SEC) {
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;

  const now = Math.floor(Date.now() / 1000);
  if (now - parsed.timestamp > toleranceSec) return false;

  const expected = sign(rawBody, secret, parsed.timestamp);

  if (expected.length !== parsed.signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parsed.signature));
}
