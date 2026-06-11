import test from 'node:test';
import assert from 'node:assert';
import { CircuitBreaker } from '../utils/circuitBreaker.js';

// --- Circuit Breaker unit tests ---

test('starts in CLOSED state and allows requests', () => {
  const cb = new CircuitBreaker({ failureThreshold: 3 });
  assert.strictEqual(cb.state, 'CLOSED');
  assert.strictEqual(cb.canExecute(), true);
});

test('trips to OPEN after reaching failure threshold', () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, windowMs: 5000 });

  cb.onFailure();
  cb.onFailure();
  assert.strictEqual(cb.state, 'CLOSED');

  cb.onFailure();
  assert.strictEqual(cb.state, 'OPEN');
  assert.strictEqual(cb.canExecute(), false);
});

test('clears old failures outside the rolling window', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, windowMs: 100 });

  cb.onFailure();
  cb.onFailure();

  await new Promise(r => setTimeout(r, 150));

  // Third failure, but the first two should have expired
  cb.onFailure();
  assert.strictEqual(cb.state, 'CLOSED');
  assert.strictEqual(cb.failures.length, 1);
});

test('transitions OPEN -> HALF_OPEN -> CLOSED on recovery', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100 });

  cb.onFailure();
  cb.onFailure();
  assert.strictEqual(cb.state, 'OPEN');

  await new Promise(r => setTimeout(r, 150));

  assert.strictEqual(cb.canExecute(), true);
  assert.strictEqual(cb.state, 'HALF_OPEN');

  cb.onSuccess();
  assert.strictEqual(cb.state, 'CLOSED');
  assert.deepStrictEqual(cb.failures, []);
});

test('doubles cooldown on HALF_OPEN probe failure (exponential backoff)', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100 });

  cb.onFailure();
  cb.onFailure();

  await new Promise(r => setTimeout(r, 150));
  cb.canExecute(); // -> HALF_OPEN

  cb.onFailure(); // probe fails
  assert.strictEqual(cb.state, 'OPEN');
  assert.strictEqual(cb._currentCooldown, 200);

  // 150ms is not enough for a 200ms cooldown
  await new Promise(r => setTimeout(r, 150));
  assert.strictEqual(cb.canExecute(), false);

  // After another 100ms (250ms total) it should be available
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(cb.canExecute(), true);
});

// --- Integration tests (requires the server to be running) ---

test('GET /health returns 200', async () => {
  const app = (await import('./index.js')).default;

  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.strictEqual(res.statusCode, 200);

  const body = JSON.parse(res.payload);
  assert.strictEqual(body.status, 'ok');

  // GET /getUsers should return an array
  const users = await app.inject({ method: 'GET', url: '/getUsers' });
  assert.strictEqual(users.statusCode, 200);
  assert.ok(Array.isArray(JSON.parse(users.payload)));

  // GET /getEventsByUserId/1 — verify parallel fetch is fast
  // User 1 has 2 events, each with a 500ms mock delay.
  // Sequential: ~1000ms. Parallel: ~500ms. We allow up to 900ms.
  const start = Date.now();
  const events = await app.inject({ method: 'GET', url: '/getEventsByUserId/1' });
  const elapsed = Date.now() - start;

  assert.strictEqual(events.statusCode, 200);
  assert.ok(Array.isArray(JSON.parse(events.payload)));
  assert.ok(elapsed < 900, `Parallel fetch took ${elapsed}ms, expected < 900ms`);

  await app.close();
});
