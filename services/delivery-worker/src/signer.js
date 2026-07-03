import crypto from 'crypto';

export function sign(payload, secret, timestamp) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${timestamp}.${payload}`);
  return hmac.digest('hex');
}

export function formatSignatureHeader(timestamp, hexSig) {
  return `t=${timestamp},v1=${hexSig}`;
}
