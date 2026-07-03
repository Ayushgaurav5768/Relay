import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@relay/lib/logger.js';
import { withTransaction } from '@relay/lib/db.js';
import { EventRepository } from '@relay/lib/repositories/EventRepository.js';
import { DestinationRepository } from '@relay/lib/repositories/DestinationRepository.js';
import { DeliveryAttemptRepository } from '@relay/lib/repositories/DeliveryAttemptRepository.js';
import { OutboxRepository } from '@relay/lib/repositories/OutboxRepository.js';
import { authMiddleware } from './auth.js';
import { rateLimiter } from './rateLimiter.js';

const log = createLogger({ service: 'ingest' });
const router = Router();

router.use(authMiddleware);
router.use(rateLimiter);

const eventSchema = z.object({
  destination_id: z.string().min(1, 'destination_id is required'),
  event_type: z.string().min(1, 'event_type is required'),
  payload: z.record(z.unknown()),
  idempotency_key: z.string().nullable().optional(),
});

router.post('/events', async (req, res) => {
  const parsed = eventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'validation failed',
      details: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  const { destination_id, event_type, payload, idempotency_key } = parsed.data;
  const destRepo = new DestinationRepository();
  const destination = await destRepo.findById(destination_id);

  if (!destination) {
    res.status(404).json({ error: 'destination not found' });
    return;
  }

  if (destination.status !== 'active') {
    res.status(422).json({ error: 'destination is not active' });
    return;
  }

  if (destination.owner_id !== req.owner_id) {
    res.status(403).json({ error: 'destination does not belong to this owner' });
    return;
  }

  const eventRepo = new EventRepository();
  const outboxRepo = new OutboxRepository();
  const eventId = uuidv4();

  if (idempotency_key) {
    const existing = await eventRepo.findByIdempotencyKey(destination_id, idempotency_key);
    if (existing) {
      log.info({ event_id: existing.id, idempotency_key }, 'duplicate idempotency key');
      res.status(200).json({ event_id: existing.id, duplicate: true });
      return;
    }
  }

  try {
    const event = await withTransaction(async (client) => {
      const inserted = await eventRepo.insert({
        id: eventId,
        destination_id,
        event_type,
        payload,
        idempotency_key: idempotency_key || null,
      }, client);

      await outboxRepo.insert({
        event_id: inserted.id,
        destination_id,
        routing_key: destination_id,
        payload: {
          event_id: inserted.id,
          destination_id,
          event_type,
          payload,
        },
      }, client);

      return inserted;
    });

    log.info({ event_id: event.id, destination_id, event_type }, 'event ingested');

    res.status(201).json({
      event_id: event.id,
      destination_id: event.destination_id,
      event_type: event.event_type,
      created_at: event.created_at,
    });
  } catch (err) {
    if (err.code === '23505' && idempotency_key) {
      const existing = await eventRepo.findByIdempotencyKey(destination_id, idempotency_key);
      if (existing) {
        res.status(200).json({ event_id: existing.id, duplicate: true });
        return;
      }
    }
    log.error({ err, event_id: eventId }, 'failed to insert event');
    res.status(500).json({ error: 'internal error' });
  }
});

router.get('/events/:id', async (req, res) => {
  const eventRepo = new EventRepository();
  const event = await eventRepo.findById(req.params.id);

  if (!event) {
    res.status(404).json({ error: 'event not found' });
    return;
  }

  res.json(event);
});

router.post('/events/:id/replay', async (req, res) => {
  const eventRepo = new EventRepository();
  const destRepo = new DestinationRepository();
  const attemptRepo = new DeliveryAttemptRepository();
  const outboxRepo = new OutboxRepository();

  const event = await eventRepo.findById(req.params.id);
  if (!event) {
    res.status(404).json({ error: 'event not found' });
    return;
  }

  if (event.status !== 'dead') {
    res.status(422).json({ error: 'only dead-lettered events can be replayed', status: event.status });
    return;
  }

  const destination = await destRepo.findById(event.destination_id);
  if (!destination) {
    res.status(404).json({ error: 'destination not found' });
    return;
  }

  if (destination.owner_id !== req.owner_id) {
    res.status(403).json({ error: 'destination does not belong to this owner' });
    return;
  }

  if (destination.status !== 'active') {
    res.status(422).json({ error: 'destination is not active' });
    return;
  }

  try {
    await withTransaction(async (client) => {
      await attemptRepo.deleteByEventId(event.id);
      await eventRepo.updateStatus(event.id, 'pending', client);
      await outboxRepo.insert({
        event_id: event.id,
        destination_id: event.destination_id,
        routing_key: event.destination_id,
        payload: {
          event_id: event.id,
          destination_id: event.destination_id,
          event_type: event.event_type,
          payload: event.payload,
        },
      }, client);
    });

    log.info({ event_id: event.id, destination_id: event.destination_id }, 'event replayed');

    res.status(200).json({
      event_id: event.id,
      destination_id: event.destination_id,
      event_type: event.event_type,
      status: 'pending',
    });
  } catch (err) {
    log.error({ err, event_id: event.id }, 'failed to replay event');
    res.status(500).json({ error: 'internal error' });
  }
});

export default router;
