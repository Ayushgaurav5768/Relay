import { query } from '../db.js';

/**
 * Repository for the `delivery_attempts` table and the retry-scheduling
 * workflow (writing next_retry_at directly on the attempt row via the
 * upsert-and-update pattern).
 *
 * @typedef {import('../types.js').DeliveryAttempt} DeliveryAttempt
 */
export class DeliveryAttemptRepository {
  /**
   * Insert a delivery-attempt row and immediately update the attempt's
   * own next_retry_at if a retry is desired.
   *
   * @param {Object} data
   * @param {string} data.event_id
   * @param {number} data.attempt_number
   * @param {'pending'|'success'|'failed'} data.status
   * @param {number|null} [data.http_status_code]
   * @param {string|null} [data.response_body_snippet]
   * @param {string|null} [data.next_retry_at] - ISO timestamp; null = terminal
   * @returns {Promise<DeliveryAttempt>}
   */
  async insert(data) {
    const { rows } = await query(
      `INSERT INTO delivery_attempts
         (event_id, attempt_number, status, http_status_code,
          response_body_snippet, next_retry_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        data.event_id,
        data.attempt_number,
        data.status,
        data.http_status_code || null,
        data.response_body_snippet || null,
        data.next_retry_at || null,
      ]
    );
    return rows[0];
  }

  /**
   * Mark an attempt as success and clear any pending retry.
   * @param {string} attemptId
   * @returns {Promise<DeliveryAttempt|null>}
   */
  async markSuccess(attemptId) {
    const { rows } = await query(
      `UPDATE delivery_attempts
       SET status = 'success', next_retry_at = NULL
       WHERE id = $1
       RETURNING *`,
      [attemptId]
    );
    return rows[0] || null;
  }

  /**
   * Mark an attempt as failed and optionally schedule a retry.
   * @param {string} attemptId
   * @param {string|null} nextRetryAt - ISO timestamp, null = no retry
   * @returns {Promise<DeliveryAttempt|null>}
   */
  async markFailed(attemptId, nextRetryAt) {
    const { rows } = await query(
      `UPDATE delivery_attempts
       SET status = 'failed', next_retry_at = $2
       WHERE id = $1
       RETURNING *`,
      [attemptId, nextRetryAt]
    );
    return rows[0] || null;
  }

  /**
   * Find all attempts for a given event, ordered by attempt number.
   * @param {string} eventId
   * @returns {Promise<DeliveryAttempt[]>}
   */
  async findByEventId(eventId) {
    const { rows } = await query(
      `SELECT * FROM delivery_attempts
       WHERE event_id = $1
       ORDER BY attempt_number ASC`,
      [eventId]
    );
    return rows;
  }

  /**
   * Claim and return failed attempts that are due for retry.
   *
   * Uses `FOR UPDATE SKIP LOCKED` so multiple worker instances can safely
   * poll without stepping on each other.
   *
   * @param {string} workerId  - Unique worker instance identifier
   * @param {number} [limit=50]
   * @returns {Promise<DeliveryAttempt[]>}
   */
  async claimDueRetries(workerId, limit = 50) {
    const { rows } = await query(
      `UPDATE delivery_attempts
       SET next_retry_at = NULL  -- clear the marker; worker will re-schedule if needed
       WHERE id IN (
         SELECT id FROM delivery_attempts
         WHERE status = 'failed'
           AND next_retry_at IS NOT NULL
           AND next_retry_at <= now()
         ORDER BY next_retry_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [limit]
    );
    return rows;
  }

  /**
   * Get the latest attempt for an event.
   * @param {string} eventId
   * @returns {Promise<DeliveryAttempt|null>}
   */
  async findLatestByEventId(eventId) {
    const { rows } = await query(
      `SELECT * FROM delivery_attempts
       WHERE event_id = $1
       ORDER BY attempt_number DESC
       LIMIT 1`,
      [eventId]
    );
    return rows[0] || null;
  }

  /**
   * Count attempts for a given event.
   * @param {string} eventId
   * @returns {Promise<number>}
   */
  async countByEventId(eventId) {
    const { rows } = await query(
      'SELECT COUNT(*)::int AS count FROM delivery_attempts WHERE event_id = $1',
      [eventId]
    );
    return rows[0].count;
  }
}
