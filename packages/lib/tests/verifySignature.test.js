import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { sign, verifySignature, parseSignatureHeader, formatSignatureHeader } from '../src/verifySignature.js';

const secret = crypto.randomBytes(32).toString('hex');
const payload = JSON.stringify({ event: 'order.created', data: { id: 1001 } });
const timestamp = Math.floor(Date.now() / 1000);

function makeHeader(ts, hexSig) {
  return `t=${ts},v1=${hexSig}`;
}

describe('formatSignatureHeader', () => {
  it('formats as t=<ts>,v1=<hex>', () => {
    expect(formatSignatureHeader(1000, 'abc123')).toBe('t=1000,v1=abc123');
  });
});

describe('parseSignatureHeader', () => {
  it('parses t and v1 correctly', () => {
    const result = parseSignatureHeader('t=1234567890,v1=abcdef');
    expect(result).toEqual({ timestamp: 1234567890, signature: 'abcdef' });
  });

  it('returns null for malformed header', () => {
    expect(parseSignatureHeader('')).toBeNull();
    expect(parseSignatureHeader('t=abc,v1=xxx')).toBeNull();
    expect(parseSignatureHeader('v1=xxx')).toBeNull();
    expect(parseSignatureHeader('t=123')).toBeNull();
  });
});

describe('verifySignature', () => {
  it('accepts a valid signature', () => {
    const sig = sign(payload, secret, timestamp);
    const header = makeHeader(timestamp, sig);
    expect(verifySignature(payload, header, secret)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const sig = sign(payload, secret, timestamp);
    const header = makeHeader(timestamp, sig);
    const tampered = JSON.stringify({ event: 'tampered' });
    expect(verifySignature(tampered, header, secret)).toBe(false);
  });

  it('rejects an expired timestamp (>5 min old)', () => {
    const oldTs = Math.floor(Date.now() / 1000) - 301;
    const sig = sign(payload, secret, oldTs);
    const header = makeHeader(oldTs, sig);
    expect(verifySignature(payload, header, secret)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const sig = sign(payload, secret, timestamp);
    const header = makeHeader(timestamp, sig);
    const wrongSecret = crypto.randomBytes(32).toString('hex');
    expect(verifySignature(payload, header, wrongSecret)).toBe(false);
  });

  it('rejects a malformed signature header', () => {
    expect(verifySignature(payload, 'invalid', secret)).toBe(false);
    expect(verifySignature(payload, '', secret)).toBe(false);
  });

  it('rejects when signature length differs (timing-safe)', () => {
    const sig = sign(payload, secret, timestamp);
    const shortHeader = `t=${timestamp},v1=${sig.slice(0, 32)}`;
    expect(verifySignature(payload, shortHeader, secret)).toBe(false);
  });

  it('accepts signature within tolerance (custom tolerance)', () => {
    const sig = sign(payload, secret, timestamp);
    const header = makeHeader(timestamp, sig);
    expect(verifySignature(payload, header, secret, 600)).toBe(true);
  });
});
