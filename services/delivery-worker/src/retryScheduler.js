/**
 * Compute the next retry timestamp using exponential backoff with full jitter.
 *
 * Formula:
 *   delay = min(cap, base * 2^(attemptNumber - 1)) * random(0, 1)
 *   next_retry_at = now() + delay
 *
 * This is "full jitter" as described in the AWS retry paper:
 * https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 *
 * Base delay: 2 seconds
 * Cap: 5 minutes (300,000 ms)
 *
 * @param {number} attemptNumber - The attempt number that just failed (1-indexed)
 * @param {number} maxRetries - Maximum number of retry attempts allowed
 * @returns {string|null} ISO 8601 timestamp for the next retry, or null if terminal
 */
export function computeNextRetry(attemptNumber, maxRetries) {
  if (attemptNumber > maxRetries) return null;

  const BASE_DELAY_MS = 2000;
  const CAP_MS = 5 * 60 * 1000;
  const delay = Math.min(CAP_MS, BASE_DELAY_MS * Math.pow(2, attemptNumber - 1)) * Math.random();
  return new Date(Date.now() + delay).toISOString();
}
