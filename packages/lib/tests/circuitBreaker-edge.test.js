import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEval = vi.fn();

const { CircuitBreaker } = await import('../src/circuitBreaker.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CircuitBreaker — edge cases', () => {
  it('sets key from destinationId', () => {
    const cb = new CircuitBreaker({ eval: vi.fn() }, 'dest-1');
    expect(cb.key).toBe('cb:dest-1');
  });

  it('onFailure stays OPEN when already OPEN', async () => {
    mockEval.mockResolvedValue(['OPEN', 6, 1700000000000, 2]);
    const cb = new CircuitBreaker({ eval: mockEval }, 'dest', { threshold: 5, baseCooldown: 30 });

    const result = await cb.onFailure();

    expect(result.state).toBe('OPEN');
    expect(result.failure_count).toBe(6);
  });

  it('isProbeAllowed returns allowed=true when CLOSED', async () => {
    mockEval.mockResolvedValue([1, 'CLOSED', -1]);
    const cb = new CircuitBreaker({ eval: mockEval }, 'dest');

    const result = await cb.isProbeAllowed();

    expect(result.allowed).toBe(true);
  });

  it('isProbeAllowed returns allowed=true when HALF_OPEN', async () => {
    mockEval.mockResolvedValue([1, 'HALF_OPEN', -1]);
    const cb = new CircuitBreaker({ eval: mockEval }, 'dest');

    const result = await cb.isProbeAllowed();

    expect(result.allowed).toBe(true);
  });

  it('isProbeAllowed returns allowed=false with retry_after when OPEN and cooldown active', async () => {
    mockEval.mockResolvedValue([0, 'OPEN', 5000]);
    const cb = new CircuitBreaker({ eval: mockEval }, 'dest');

    const result = await cb.isProbeAllowed();

    expect(result.allowed).toBe(false);
    expect(result.retry_after).toBe(5000);
  });

  it('reset deletes the Redis key', async () => {
    const mockDel = vi.fn().mockResolvedValue(1);
    const cb = new CircuitBreaker({ eval: mockEval, del: mockDel }, 'dest');

    await cb.reset();

    expect(mockDel).toHaveBeenCalledWith('cb:dest');
  });

  it('onSuccess returns CLOSED when transitioning from HALF_OPEN', async () => {
    mockEval.mockResolvedValue(['CLOSED', 0]);
    const cb = new CircuitBreaker({ eval: mockEval }, 'dest');

    const result = await cb.onSuccess();

    expect(result).toEqual({ state: 'CLOSED', failure_count: 0 });
  });

  it('handles Redis eval errors gracefully in getState', async () => {
    mockEval.mockRejectedValue(new Error('Redis down'));
    const cb = new CircuitBreaker({ eval: mockEval }, 'dest', { threshold: 5, baseCooldown: 30 });

    await expect(cb.getState()).rejects.toThrow('Redis down');
  });

  it('onSuccess passes key and timestamp to eval', async () => {
    mockEval.mockResolvedValue(['CLOSED', 0]);
    const cb = new CircuitBreaker({ eval: mockEval }, 'dest', { threshold: 3, baseCooldown: 60 });

    await cb.onSuccess();

    const call = mockEval.mock.calls[0];
    expect(call[0]).toContain('local key = KEYS[1]');
    expect(call[1]).toBe(1);
    expect(call[2]).toBe('cb:dest');
    expect(typeof call[3]).toBe('string');
  });

  it('onFailure passes threshold and baseCooldown to eval', async () => {
    mockEval.mockResolvedValue(['CLOSED', 1]);
    const cb = new CircuitBreaker({ eval: mockEval }, 'dest', { threshold: 3, baseCooldown: 60 });

    await cb.onFailure();

    const call = mockEval.mock.calls[0];
    expect(call[1]).toBe(1);
    expect(call[2]).toBe('cb:dest');
    expect(call[3]).toBe('3');
    expect(call[4]).toBe('60');
    expect(typeof call[5]).toBe('string');
  });
});
