import pino from 'pino';
import { config } from './config.js';

/**
 * Create a structured JSON logger.
 *
 * @param {Object} [bindings] - Extra fields to attach to every log line
 * @param {string} [bindings.service] - Service name
 * @returns {import('pino').Logger}
 */
export function createLogger(bindings = {}) {
  return pino({
    level: config.LOG_LEVEL,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    base: { service: bindings.service || 'unknown', pid: process.pid, ...bindings },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: pino.stdSerializers.err,
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
    },
  });
}
