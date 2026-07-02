import { query } from '../db.js';

/**
 * Repository for the `destinations` table.
 * @typedef {import('../types.js').Destination} Destination
 */
export class DestinationRepository {
  /**
   * Find a destination by its logical ID.
   * @param {string} id
   * @returns {Promise<Destination|null>}
   */
  async findById(id) {
    const { rows } = await query(
      'SELECT * FROM destinations WHERE id = $1',
      [id]
    );
    return rows[0] || null;
  }

  /**
   * List all destinations, ordered by id.
   * @returns {Promise<Destination[]>}
   */
  async findAll() {
    const { rows } = await query(
      'SELECT * FROM destinations ORDER BY id'
    );
    return rows;
  }

  /**
   * List only enabled destinations.
   * Used by the delivery worker to discover queues to consume from.
   * @returns {Promise<Destination[]>}
   */
  async findEnabled() {
    const { rows } = await query(
      "SELECT * FROM destinations WHERE status = 'active' ORDER BY id"
    );
    return rows;
  }

  /**
   * Create a new destination.
   * @param {Object} data
   * @param {string} data.id
   * @param {string} data.owner_id
   * @param {string} data.url
   * @param {string|null} [data.secret]
   * @param {'active'|'disabled'} [data.status]
   * @returns {Promise<Destination>}
   */
  async create(data) {
    const { rows } = await query(
      `INSERT INTO destinations (id, owner_id, url, secret, status)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'active'))
       RETURNING *`,
      [data.id, data.owner_id, data.url, data.secret || null, data.status || 'active']
    );
    return rows[0];
  }

  /**
   * Update a destination's URL and/or secret.
   * @param {string} id
   * @param {Object} changes
   * @param {string} [changes.url]
   * @param {string|null} [changes.secret]
   * @returns {Promise<Destination|null>}
   */
  async update(id, changes) {
    const setClauses = [];
    const params = [];
    let idx = 0;

    if (changes.url !== undefined) {
      idx++;
      setClauses.push(`url = $${idx}`);
      params.push(changes.url);
    }
    if (changes.secret !== undefined) {
      idx++;
      setClauses.push(`secret = $${idx}`);
      params.push(changes.secret);
    }

    if (setClauses.length === 0) return this.findById(id);

    idx++;
    params.push(id);

    const { rows } = await query(
      `UPDATE destinations SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    return rows[0] || null;
  }
}
