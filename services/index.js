import Fastify from 'fastify';
import listenMock from '../mock-server/index.js';
import { fetchWithResilience } from '../utils/circuitBreaker.js';

const fastify = Fastify({ logger: true });

const PORT = process.env.PORT || 3000;
const EVENT_SERVICE_URL = process.env.EVENT_SERVICE_URL || 'http://event.com';

fastify.get('/health', async (request, reply) => {
  reply.send({ status: 'ok', uptime: process.uptime() });
});

fastify.get('/getUsers', async (request, reply) => {
  try {
    const resp = await fetch(`${EVENT_SERVICE_URL}/getUsers`);
    const data = await resp.json();
    reply.send(data);
  } catch (err) {
    request.log.error(err, 'Failed to fetch users');
    reply.code(500).send({ error: 'Failed to fetch users' });
  }
});

fastify.post('/addEvent', async (request, reply) => {
  try {
    const resp = await fetchWithResilience(`${EVENT_SERVICE_URL}/addEvent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: new Date().getTime(),
        ...request.body
      })
    });
    const data = await resp.json();
    reply.send(data);
  } catch (err) {
    request.log.error(err, 'Failed to add event');
    const status = err.message.includes('Circuit Breaker') ? 503 : 500;
    reply.code(status).send({
      statusCode: status,
      error: status === 503 ? 'Service Unavailable' : 'Internal Server Error',
      message: status === 503
        ? 'Event service is currently unavailable. Please try again later.'
        : err.message
    });
  }
});

fastify.get('/getEvents', async (request, reply) => {
  try {
    const resp = await fetch(`${EVENT_SERVICE_URL}/getEvents`);
    const data = await resp.json();
    reply.send(data);
  } catch (err) {
    request.log.error(err, 'Failed to fetch events');
    reply.code(500).send({ error: 'Failed to fetch events' });
  }
});

fastify.get('/getEventsByUserId/:id', async (request, reply) => {
  const { id } = request.params;
  try {
    const user = await fetch(`${EVENT_SERVICE_URL}/getUserById/${id}`);
    const userData = await user.json();

    if (!userData) {
      return reply.code(404).send({ error: `User ${id} not found` });
    }

    const userEvents = userData.events || [];

    // Fetch all events in parallel instead of sequentially — the original for-loop
    // was O(n * delay) because each getEventById has a ~500ms latency from the mock.
    const eventArray = await Promise.all(
      userEvents.map(eventId =>
        fetch(`${EVENT_SERVICE_URL}/getEventById/${eventId}`).then(r => r.json())
      )
    );

    reply.send(eventArray);
  } catch (err) {
    request.log.error(err, `Failed to fetch events for user ${id}`);
    reply.code(500).send({ error: 'Failed to fetch user events' });
  }
});

// Graceful shutdown
const shutdown = (signal) => {
  fastify.log.info(`Received ${signal}, shutting down`);
  fastify.close().then(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start the mock interceptor before the server so MSW is ready for requests
listenMock();

fastify.listen({ port: PORT }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
});

export default fastify;
