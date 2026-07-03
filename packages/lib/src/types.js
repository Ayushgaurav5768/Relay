/**
 * @typedef {Object} Destination
 * @property {string} id      - Logical name, e.g. "acme-orders"
 * @property {string} owner_id
 * @property {string} url     - Webhook endpoint URL
 * @property {string|null} secret - Per-destination HMAC secret override
 * @property {'active'|'disabled'} status
 * @property {string} created_at - ISO timestamp
 */

/**
 * @typedef {Object} Event
 * @property {string} id
 * @property {string} destination_id
 * @property {string} event_type
 * @property {Object} payload
 * @property {string|null} idempotency_key
 * @property {'pending'|'delivered'|'failed'|'dead'} status
 * @property {string} created_at
 */

/**
 * @typedef {Object} DeliveryAttempt
 * @property {string} id                    - UUID
 * @property {string} event_id
 * @property {number} attempt_number
 * @property {'pending'|'success'|'failed'} status
 * @property {number|null} http_status_code
 * @property {string|null} response_body_snippet
 * @property {string} attempted_at          - ISO timestamp
 * @property {string|null} next_retry_at    - ISO timestamp
 */

/**
 * @typedef {'closed'|'open'|'half_open'} CircuitState
 */

/**
 * @typedef {Object} CircuitBreakerRecord
 * @property {string} destination_id
 * @property {CircuitState} state
 * @property {number} failure_count
 * @property {string|null} opened_at
 * @property {string|null} cooldown_until
 * @property {string} updated_at
 */

/**
 * @typedef {Object} OutboxRecord
 * @property {string} id              - UUID
 * @property {string} event_id
 * @property {string} destination_id
 * @property {string} routing_key
 * @property {Object} payload         - Parsed JSON body to publish
 * @property {boolean} published
 * @property {string} created_at      - ISO timestamp
 * @property {string|null} published_at - ISO timestamp
 */

/**
 * @typedef {Object} PaginatedResult
 * @property {Object[]} rows
 * @property {number} total
 */

export {};
