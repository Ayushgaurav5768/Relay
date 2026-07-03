import crypto from 'crypto';

export function sign(payload, secret, timestamp) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${timestamp}.${payload}`);
  return `sha256=${hmac.digest('hex')}`;
}
