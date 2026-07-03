import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEval = vi.fn();
const mockDel = vi.fn();
const mockRedis = {
  eval: mockEval,
  del: mockDel,
};

const { CircuitBreaker } = await import('../src/circuitBreaker.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CircuitBreaker', () => {
  const destId = 'test-dest';
  let cb;

  beforeEach(() => {
    cb = new CircuitBreaker(mockRedis, destId, { threshold: 5, baseCooldown: 30 });
  });

  describe('onSuccess', () => {
    it('returns CLOSED state with zero failure count', async () => {
      mockEval.mockResolvedValue(['CLOSED', 0]);

      const result = await cb.onSuccess();

      expect(result).toEqual({ state: 'CLOSED', failure_count: 0 });
      expect(mockEval).toHaveBeenCalledTimes(1);
      expect(mockEval.mock.calls[0][1]).toBe(1);
      expect(mockEval.mock.calls[0][2]).toBe('cb:test-dest');
    });

    it('resets failure count when called in CLOSED', async () => {
      mockEval.mockResolvedValue(['CLOSED', 0]);

      const result = await cb.onSuccess();

      expect(result.failure_count).toBe(0);
    });

    it('transitions HALF_OPEN to CLOSED', async () => {
      mockEval.mockResolvedValue(['CLOSED', 0]);

      const result = await cb.onSuccess();

      expect(result.state).toBe('CLOSED');
    });
  });

  describe('onFailure', () => {
    it('increments failure count and stays CLOSED when under threshold', async () => {
      mockEval.mockResolvedValue(['CLOSED', 3, -1, 0]);

      const result = await cb.onFailure();

      expect(result.state).toBe('CLOSED');
      expect(result.failure_count).toBe(3);
      expect(result.open_count).toBe(0);
    });

    it('trips to OPEN when failure count reaches threshold', async () => {
      const future = Date.now() + 30000;
      mockEval.mockResolvedValue(['OPEN', 5, future, 1]);

      const result = await cb.onFailure();

      expect(result.state).toBe('OPEN');
      expect(result.failure_count).toBe(5);
      expect(result.open_count).toBe(1);
      expect(result.cooldown_until).toBe(future);
    });

    it('transitions HALF_OPEN back to OPEN with extended cooldown', async () => {
      const future = Date.now() + 60000;
      mockEval.mockResolvedValue(['OPEN', 6, future, 2]);

      const result = await cb.onFailure();

      expect(result.state).toBe('OPEN');
      expect(result.open_count).toBe(2);
      expect(result.cooldown_until).toBeGreaterThan(Date.now());
    });

    it('stays OPEN when already OPEN', async () => {
      const cooldownUntil = Date.now() + 10000;
      mockEval.mockResolvedValue(['OPEN', 6, cooldownUntil, 1]);

      const result = await cb.onFailure();

      expect(result.state).toBe('OPEN');
      expect(result.failure_count).toBe(6);
    });

    it('passes threshold and baseCooldown to eval', async () => {
      mockEval.mockResolvedValue(['CLOSED', 1, -1, 0]);

      await cb.onFailure();

      const args = mockEval.mock.calls[0];
      expect(args[3]).toBe('5');
      expect(args[4]).toBe('30');
    });
  });

  describe('isProbeAllowed', () => {
    it('returns allowed=true in CLOSED state', async () => {
      mockEval.mockResolvedValue([1, 'CLOSED', -1]);

      const result = await cb.isProbeAllowed();

      expect(result.allowed).toBe(true);
      expect(result.state).toBe('CLOSED');
    });

    it('returns allowed=true in HALF_OPEN state', async () => {
      mockEval.mockResolvedValue([1, 'HALF_OPEN', -1]);

      const result = await cb.isProbeAllowed();

      expect(result.allowed).toBe(true);
      expect(result.state).toBe('HALF_OPEN');
    });

    it('transitions OPEN to HALF_OPEN when cooldown expired', async () => {
      mockEval.mockResolvedValue([1, 'HALF_OPEN', -1]);

      const result = await cb.isProbeAllowed();

      expect(result.allowed).toBe(true);
      expect(result.state).toBe('HALF_OPEN');
    });

    it('returns allowed=false in OPEN with retry_after when cooldown not expired', async () => {
      mockEval.mockResolvedValue([0, 'OPEN', 15000]);

      const result = await cb.isProbeAllowed();

      expect(result.allowed).toBe(false);
      expect(result.state).toBe('OPEN');
      expect(result.retry_after).toBe(15000);
    });
  });

  describe('getState', () => {
    it('returns state, failure_count, cooldown_until, opened_at, open_count', async () => {
      mockEval.mockResolvedValue(['CLOSED', 3, -1, -1, 0]);

      const result = await cb.getState();

      expect(result).toEqual({
        state: 'CLOSED',
        failure_count: 3,
        cooldown_until: -1,
        opened_at: -1,
        open_count: 0,
      });
    });

    it('returns OPEN state with cooldown and opened_at timestamps', async () => {
      const now = Date.now();
      mockEval.mockResolvedValue(['OPEN', 5, now + 30000, now, 1]);

      const result = await cb.getState();

      expect(result.state).toBe('OPEN');
      expect(result.failure_count).toBe(5);
      expect(result.cooldown_until).toBe(now + 30000);
      expect(result.opened_at).toBe(now);
      expect(result.open_count).toBe(1);
    });
  });

  describe('reset', () => {
    it('deletes the Redis key', async () => {
      mockDel.mockResolvedValue(1);

      await cb.reset();

      expect(mockDel).toHaveBeenCalledWith('cb:test-dest');
    });
  });

  describe('constructor defaults', () => {
    it('uses config defaults when options not provided', async () => {
      const defaultCb = new CircuitBreaker(mockRedis, 'default-dest');
      mockEval.mockResolvedValue(['CLOSED', 1, -1, 0]);

      await defaultCb.onFailure();

      const args = mockEval.mock.calls[0];
      expect(args[3]).toBe('5');
      expect(args[4]).toBe('30');
    });
  });
});
