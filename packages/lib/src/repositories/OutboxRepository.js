import { query } from '../db.js';

/**
 * Repository for the `outbox` table.
 *
 * @typedef {import('../types.js').OutboxRecord} OutboxRecord
 */
export class OutboxRepository {
  /**
   * Insert an outbox record.
   * Accepts an optional `client` for use inside a managed transaction.
   *
   * @param {Object} data
   * @param {string} data.event_id
   * @param {string} data.destination_id
   * @param {string} data.routing_key
   * @param {Object} data.payload       - JSON-serialisable message body
   * @param {import('pg').PoolClient} [client] - Transaction client
   * @returns {Promise<OutboxRecord>}
   */
  async insert(data, client) {
    const db = client || query;
    const { rows } = await db(
      `INSERT INTO outbox (event_id, destination_id, routing_key, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING *`,
      [
        data.event_id,
        data.destination_id,
        data.routing_key,
        JSON.stringify(data.payload),
      ]
    );
    return rows[0];
  }

  /**
   * Claim unpublished outbox records for processing.
   * Uses FOR UPDATE SKIP LOCKED so multiple publisher instances
   * can coexist safely.
   *
   * @param {number} [limit=50]
   * @returns {Promise<OutboxRecord[]>}
   */
  async claimUnpublished(limit = 50) {
    const { rows } = await query(
      `SELECT * FROM outbox
       WHERE published = false
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit]
    );
    return rows;
  }

  /**
   * Mark an outbox record as published.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async markPublished(id) {
    await query(
      `UPDATE outbox SET published = true, published_at = now() WHERE id = $1`,
      [id]
    );
  }
}
