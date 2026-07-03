import { describe, it, expect } from 'vitest';
import { sign } from '../src/signer.js';

describe('sign', () => {
  it('produces a deterministic HMAC-SHA256 signature', () => {
    const result = sign('payload', 'secret', 1000);
    expect(result).toMatch(/^sha256=[a-f0-9]{64}$/);
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

  it('always produces a sha256= prefix', () => {
    const result = sign('x', 'y', 1);
    expect(result).toMatch(/^sha256=/);
  });

  it('handles empty payload', () => {
    const result = sign('', 'secret', 1);
    expect(result).toMatch(/^sha256=[a-f0-9]{64}$/);
  });
});
