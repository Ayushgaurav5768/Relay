import { z } from 'zod';

const envSchema = z.object({
  PGHOST: z.string().default('localhost'),
  PGPORT: z.coerce.number().default(5432),
  PGDATABASE: z.string().default('relay'),
  PGUSER: z.string().default('relay'),
  PGPASSWORD: z.string().default('relay_dev'),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  RABBITMQ_HOST: z.string().default('localhost'),
  RABBITMQ_PORT: z.coerce.number().default(5672),
  RABBITMQ_USER: z.string().default('relay'),
  RABBITMQ_PASSWORD: z.string().default('relay_dev'),
  INGEST_PORT: z.coerce.number().default(3001),
  INGEST_HMAC_SECRET: z.string().default('dev-secret'),
  DELIVERY_WORKER_PORT: z.coerce.number().default(3002),
  DELIVERY_HMAC_SECRET: z.string().default('dev-secret'),
  MAX_RETRIES: z.coerce.number().default(5),
  CB_FAILURE_THRESHOLD: z.coerce.number().default(5),
  CB_COOLDOWN_SECONDS: z.coerce.number().default(30),
  CB_HALF_OPEN_SUCCESS_THRESHOLD: z.coerce.number().default(2),
  DASHBOARD_PORT: z.coerce.number().default(3003),
  FLAKY_PORT: z.coerce.number().default(9099),
  FLAKY_EVERY: z.coerce.number().default(3),
  FLAKY_LATENCY: z.coerce.number().default(0),
  FLAKY_FAIL_STATUS: z.coerce.number().default(500),
  CLIENT_PORT: z.coerce.number().default(5173),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

/** @type {z.infer<typeof envSchema>} */
export const config = envSchema.parse(process.env);
