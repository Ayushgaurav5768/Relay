import amqplib from 'amqplib';
import { config } from './config.js';

let connection = null;
let channel = null;

export const EXCHANGE_NAME = 'relay.events';

/**
 * Connect to RabbitMQ and assert the topic exchange.
 * @returns {Promise<import('amqplib').Channel>}
 */
export async function connectRabbitMQ() {
  if (channel) return channel;

  const url = `amqp://${config.RABBITMQ_USER}:${config.RABBITMQ_PASSWORD}@${config.RABBITMQ_HOST}:${config.RABBITMQ_PORT}`;
  connection = await amqplib.connect(url);
  channel = await connection.createChannel();
  await channel.assertExchange(EXCHANGE_NAME, 'topic', { durable: true });

  channel.on('error', (err) => {
    console.error('rabbitmq channel error', err);
  });

  return channel;
}

/**
 * Check RabbitMQ connectivity.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function checkRabbitMQ() {
  try {
    const ch = await connectRabbitMQ();
    // A simple passive declare verifies the channel is alive
    await ch.checkExchange(EXCHANGE_NAME);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Gracefully close RabbitMQ.
 * @returns {Promise<void>}
 */
export async function closeRabbitMQ() {
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
  } finally {
    channel = null;
    connection = null;
  }
}
