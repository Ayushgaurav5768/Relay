import { describe, it, expect } from 'vitest';
import { computeNextRetry } from '../src/retryScheduler.js';

describe('computeNextRetry', () => {
  it('returns null when attemptNumber exceeds maxRetries', () => {
    expect(computeNextRetry(4, 3)).toBeNull();
    expect(computeNextRetry(1, 0)).toBeNull();
  });

  it('returns an ISO timestamp when retry is allowed', () => {
    const result = computeNextRetry(1, 3);
    expect(result).not.toBeNull();
    expect(typeof result).toBe('string');
    expect(() => new Date(result)).not.toThrow();
  });

  it('returns a future timestamp', () => {
    const before = Date.now();
    const result = computeNextRetry(1, 3);
    const ts = new Date(result).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
  });

  it('generates varying timestamps on successive calls (jitter)', () => {
    const results = new Set();
    for (let i = 0; i < 50; i++) {
      results.add(computeNextRetry(2, 5));
    }
    expect(results.size).toBeGreaterThan(1);
  });

  it('base delay for attempt 1 is within 0-2000ms', () => {
    const timestamps = [];
    for (let i = 0; i < 100; i++) {
      const ts = new Date(computeNextRetry(1, 5)).getTime();
      timestamps.push(ts - Date.now());
    }
    const max = Math.max(...timestamps);
    expect(max).toBeLessThanOrEqual(2100);
    expect(max).toBeGreaterThan(0);
  });

  it('delay doubles roughly for each subsequent attempt (until cap)', () => {
    const d1 = new Date(computeNextRetry(1, 5)).getTime() - Date.now();
    const d2 = new Date(computeNextRetry(2, 5)).getTime() - Date.now();
    const d3 = new Date(computeNextRetry(3, 5)).getTime() - Date.now();

    expect(d1).toBeLessThanOrEqual(2100);
    expect(d2).toBeLessThanOrEqual(4100);
    expect(d3).toBeLessThanOrEqual(8100);
  });

  it('caps delay at 5 minutes for large attempt numbers', () => {
    for (let i = 0; i < 50; i++) {
      const ts = new Date(computeNextRetry(10, 15)).getTime();
      const delay = ts - Date.now();
      expect(delay).toBeLessThanOrEqual(5 * 60 * 1000 + 100);
    }
  });

  it('returns at least 0ms delay (no negative values)', () => {
    for (let i = 0; i < 100; i++) {
      const ts = new Date(computeNextRetry(1, 3)).getTime();
      const delay = ts - Date.now();
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  });

  it('maxRetries=0 disallows any retry', () => {
    expect(computeNextRetry(1, 0)).toBeNull();
  });

  it('attempt equals maxRetries (last allowed) returns a timestamp', () => {
    const result = computeNextRetry(5, 5);
    expect(result).not.toBeNull();
    expect(typeof result).toBe('string');
    const ts = new Date(result).getTime();
    expect(ts).toBeGreaterThan(Date.now() - 1000);
  });

  it('jitter produces values across the full distribution (not all near zero)', () => {
    const delays = [];
    for (let i = 0; i < 200; i++) {
      const ts = new Date(computeNextRetry(3, 5)).getTime();
      delays.push(ts - Date.now());
    }
    const max = Math.max(...delays);
    const min = Math.min(...delays);
    // With full jitter on 8s window, max should be near 8000 and min near 0
    expect(max).toBeGreaterThan(4000);
    expect(min).toBeLessThan(1000);
  });
});
