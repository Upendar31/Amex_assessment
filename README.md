# Event Management System

Backend service for an Event Management System built with Node.js and Fastify.

## Getting Started

```bash
npm install
npm start
```

The server starts on `http://localhost:3000`. Configuration is loaded from a `.env` file:

```env
PORT=3000
EVENT_SERVICE_URL=http://event.com
NODE_ENV=development
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/getUsers` | Returns list of users |
| GET | `/getEvents` | Returns list of events |
| GET | `/getEventsByUserId/:id` | Returns events for a specific user |
| POST | `/addEvent` | Creates a new event |
| GET | `/health` | Health check |

### POST /addEvent payload

```json
{
  "name": "Team standup",
  "userId": "3"
}
```

## Running Tests

```bash
npm test
```

Uses Node's built-in test runner (`node:test`) — no extra test dependencies needed.

## Implementation Details

### Configuration (Task 1)

- **ES Modules**: Set `"type": "module"` in package.json. The `msw` dependency requires ESM, and using native imports keeps things cleaner than CommonJS workarounds.
- **Environment variables**: Uses Node's native `--env-file` flag (Node 20.6+) to load `.env` — no `dotenv` dependency needed.
- **.gitignore**: Added to exclude `node_modules`, `.env`, OS files, and debug logs.
- **Error handling**: All endpoints have try/catch blocks with proper error responses. The original code had a `reply.error(err)` call in `/addEvent` which would throw a TypeError (not a valid Fastify method) — fixed to use `reply.code(500)`.
- **Graceful shutdown**: Listens for `SIGTERM`/`SIGINT` to close the server cleanly.
- **Health check**: Added `/health` endpoint for monitoring.

### Performance (Task 2)

The `/getEventsByUserId/:id` endpoint was fetching event details sequentially in a `for` loop. With the mock's 500ms delay per event, a user with N events would take N × 500ms to respond.

Fixed by replacing the loop with `Promise.all()` — all event fetches run concurrently, so the response time is ~500ms regardless of event count. The test suite verifies this by asserting the response completes in under 900ms for a user with 2 events.

### Resilience (Task 3)

Implemented a custom circuit breaker for the `/addEvent` endpoint (the only endpoint whose external API has rate limits). No third-party libraries used.

**How it works:**

- **CLOSED** (normal): Requests pass through. Failures are tracked in a 30-second rolling window.
- **OPEN** (tripped): After 3+ failures in the window, the circuit opens. All requests are immediately rejected with a 503 — this stops hammering the failing service.
- **HALF_OPEN** (probing): After a cooldown period, one request is allowed through as a probe. If it succeeds, we go back to CLOSED. If it fails, we go back to OPEN with a doubled cooldown (exponential backoff, capped at 60s).

Requests also retry up to 2 times with exponential backoff (100ms, 200ms) before counting as a circuit breaker failure, so transient blips don't trip the circuit unnecessarily.

The breaker is scoped only to `/addEvent` — read endpoints use plain `fetch()` and aren't affected by write-path failures.

## Future Improvements

- **Input validation**: Add Fastify JSON schemas for request bodies (e.g. validate `name` and `userId` on `/addEvent`). Right now invalid payloads pass straight through to the external API.
- **Structured routing**: Split routes, controllers, and service calls into separate files. Everything lives in `services/index.js` right now, which works for this size but won't scale well.
- **Caching**: Read endpoints (`/getUsers`, `/getEvents`) could benefit from short-lived caching to reduce redundant downstream calls.
