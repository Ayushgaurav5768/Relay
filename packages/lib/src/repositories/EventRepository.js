import { query } from '../db.js';

/**
 * Repository for the `events` table.
 * @typedef {import('../types.js').Event} Event
 * @typedef {import('../types.js').PaginatedResult} PaginatedResult
 */
export class EventRepository {
  /**
   * Insert a new event.
   * If `idempotency_key` is provided and a row with the same
   * (destination_id, idempotency_key) already exists, the unique
   * partial index rejects the duplicate.
   *
   * Accepts an optional `client` for use inside a managed transaction.
   *
   * @param {Object} data
   * @param {string} data.id
   * @param {string} data.destination_id
   * @param {string} data.event_type
   * @param {Object} data.payload  - Parsed JSON object (will be stringified)
   * @param {string|null} [data.idempotency_key]
   * @param {import('pg').PoolClient} [client] - Transaction client
   * @returns {Promise<Event>}
   * @throws {Error} With code 23505 on idempotency violation
   */
  async insert(data, client) {
    const db = client || query;
    const { rows } = await db(
      `INSERT INTO events (id, destination_id, event_type, payload, idempotency_key, status)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'pending')
       RETURNING *`,
      [
        data.id,
        data.destination_id,
        data.event_type,
        JSON.stringify(data.payload),
        data.idempotency_key || null,
      ]
    );
    return rows[0];
  }

  /**
   * Update an event's status.
   * @param {string} eventId
   * @param {'pending'|'delivered'|'failed'|'dead'} status
   * @param {import('pg').PoolClient} [client] - Transaction client
   * @returns {Promise<Event|null>}
   */
  async updateStatus(eventId, status, client) {
    const db = client || query;
    const { rows } = await db(
      'UPDATE events SET status = $2 WHERE id = $1 RETURNING *',
      [eventId, status]
    );
    return rows[0] || null;
  }

  /**
   * Find an event by UUID.
   * @param {string} id
   * @returns {Promise<Event|null>}
   */
  async findById(id) {
    const { rows } = await query(
      'SELECT * FROM events WHERE id = $1',
      [id]
    );
    return rows[0] || null;
  }

  /**
   * Find an event by idempotency key for a given destination.
   * @param {string} destinationId
   * @param {string} idempotencyKey
   * @returns {Promise<Event|null>}
   */
  async findByIdempotencyKey(destinationId, idempotencyKey) {
    const { rows } = await query(
      'SELECT * FROM events WHERE destination_id = $1 AND idempotency_key = $2',
      [destinationId, idempotencyKey]
    );
    return rows[0] || null;
  }

  /**
   * List events with optional filters and pagination.
   *
   * @param {Object} [filters]
   * @param {string} [filters.destination_id]
   * @param {string} [filters.status]
   * @param {number} [filters.limit=50]
   * @param {number} [filters.offset=0]
   * @returns {Promise<PaginatedResult>}
   */
  async list(filters = {}) {
    const conditions = [];
    const params = [];
    let idx = 0;

    if (filters.destination_id) {
      idx++;
      conditions.push(`e.destination_id = $${idx}`);
      params.push(filters.destination_id);
    }

    /* status is on delivery_attempts, not events — we join to filter by it */
    if (filters.status) {
      idx++;
      conditions.push(`da.status = $${idx}`);
      params.push(filters.status);
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const limit = filters.limit || 50;
    const offset = filters.offset || 0;

    idx++;
    const limitParam = `$${idx}`;
    params.push(limit);
    idx++;
    const offsetParam = `$${idx}`;
    params.push(offset);

    /* If filtering by status we must join, otherwise a plain count is enough */
    const needsJoin = !!filters.status;

    const fromClause = needsJoin
      ? `FROM events e LEFT JOIN LATERAL (
           SELECT status FROM delivery_attempts
           WHERE event_id = e.id
           ORDER BY attempt_number DESC LIMIT 1
         ) da ON true`
      : 'FROM events e';

    const [{ rows: countRows }, { rows }] = await Promise.all([
      query(`SELECT COUNT(*) ${fromClause} ${whereClause}`, params),
      query(
        `SELECT e.* ${fromClause}
         ${whereClause}
         ORDER BY e.created_at DESC
         LIMIT ${limitParam} OFFSET ${offsetParam}`,
        params
      ),
    ]);

    return {
      rows,
      total: parseInt(countRows[0].count, 10),
    };
  }

  /**
   * List events with delivery-attempt counts, optional filters by event
   * status, and page-based pagination.
   *
   * Intended for the dashboard API (GET /events).
   *
   * @param {Object} [filters]
   * @param {string} [filters.destination_id]
   * @param {string} [filters.status] - Filter by events.status
   * @param {number} [filters.page=1]
   * @param {number} [filters.limit=50] - Max 100
   * @returns {Promise<{rows: Array, total: number}>}
   */
  async listWithAttemptCounts(filters = {}) {
    const conditions = [];
    const params = [];

    if (filters.destination_id) {
      conditions.push(`e.destination_id = $${params.length + 1}`);
      params.push(filters.destination_id);
    }

    if (filters.status) {
      conditions.push(`e.status = $${params.length + 1}`);
      params.push(filters.status);
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const page = Math.max(1, filters.page || 1);
    const limit = Math.min(100, Math.max(1, filters.limit || 50));
    const offset = (page - 1) * limit;

    const [{ rows: countRows }, { rows }] = await Promise.all([
      query(
        `SELECT COUNT(*) FROM events e ${whereClause}`,
        params
      ),
      query(
        `SELECT e.*,
          COALESCE(
            (SELECT COUNT(*)::int FROM delivery_attempts da WHERE da.event_id = e.id),
            0
          ) AS attempt_count
         FROM events e
         ${whereClause}
         ORDER BY e.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);

    return {
      rows,
      total: parseInt(countRows[0].count, 10),
    };
  }
}
