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

describe('sign — edge cases', () => {
  it('handles unicode payload', () => {
    const result = sign('{"msg": "héllo 世界"}', 'secret', 1);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles large payload (100KB)', () => {
    const large = 'x'.repeat(100_000);
    const result = sign(large, 'secret', 1);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles special characters in secret', () => {
    const result = sign('payload', '!@#$%^&*()_\n\t\\', 1);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles very long secret (1KB)', () => {
    const longSecret = 'k'.repeat(1024);
    const result = sign('payload', longSecret, 1);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles empty secret', () => {
    const result = sign('payload', '', 1);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles zero timestamp', () => {
    const result = sign('payload', 'secret', 0);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('formatSignatureHeader', () => {
  it('formats as t=<ts>,v1=<hex>', () => {
    const result = formatSignatureHeader(1000, 'abc123');
    expect(result).toBe('t=1000,v1=abc123');
  });
});
