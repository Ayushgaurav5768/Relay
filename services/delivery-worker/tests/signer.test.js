import { describe, it, expect } from 'vitest';
import { sign, formatSignatureHeader } from '../src/signer.js';

describe('sign', () => {
  it('produces a deterministic HMAC-SHA256 hex string', () => {
    const result = sign('payload', 'secret', 1000);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
    const result2 = sign('payload', 'secret', 1000);
    expect(result).toBe(result2);
  });

  it('produces different signatures for different payloads', () => {
    const a = sign('payload-a', 'secret', 1000);
    const b = sign('payload-b', 'secret', 1000);
    expect(a).not.toBe(b);
  });

  it('produces different signatures for different timestamps', () => {
    const a = sign('payload', 'secret', 1000);
    const b = sign('payload', 'secret', 2000);
    expect(a).not.toBe(b);
  });

  it('produces different signatures for different secrets', () => {
    const a = sign('payload', 'secret-a', 1000);
    const b = sign('payload', 'secret-b', 1000);
    expect(a).not.toBe(b);
  });

  it('always produces a 64-char hex string', () => {
    const result = sign('x', 'y', 1);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles empty payload', () => {
    const result = sign('', 'secret', 1);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('formatSignatureHeader', () => {
  it('formats as t=<ts>,v1=<hex>', () => {
    const result = formatSignatureHeader(1000, 'abc123');
    expect(result).toBe('t=1000,v1=abc123');
  });
});
