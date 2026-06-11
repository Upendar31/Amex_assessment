/**
 * Simple circuit breaker implementation.
 *
 * States: CLOSED (normal) -> OPEN (blocking) -> HALF_OPEN (testing recovery)
 *
 * Tracks failures in a rolling time window. When the threshold is hit,
 * the circuit opens and rejects requests immediately until a cooldown
 * period elapses. After cooldown, one probe request is allowed through —
 * if it succeeds we close the circuit, if it fails we re-open with a
 * longer cooldown (exponential backoff, capped at 60s).
 */
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.windowMs = options.windowMs ?? 30_000;
    this.cooldownMs = options.cooldownMs ?? 30_000;

    this.state = 'CLOSED';
    this.failures = [];
    this.nextAttemptAt = 0;
    this._currentCooldown = this.cooldownMs;
  }

  canExecute() {
    if (this.state !== 'OPEN') return true;

    if (Date.now() >= this.nextAttemptAt) {
      this.state = 'HALF_OPEN';
      return true;
    }
    return false;
  }

  onSuccess() {
    this.state = 'CLOSED';
    this.failures = [];
    this._currentCooldown = this.cooldownMs;
  }

  onFailure() {
    const now = Date.now();
    this.failures.push(now);
    this.failures = this.failures.filter(t => now - t <= this.windowMs);

    if (this.state === 'HALF_OPEN') {
      // Probe failed — back to OPEN with longer cooldown
      this.state = 'OPEN';
      this._currentCooldown = Math.min(this._currentCooldown * 2, 60_000);
      this.nextAttemptAt = now + this._currentCooldown;
    } else if (this.failures.length >= this.failureThreshold) {
      this.state = 'OPEN';
      this._currentCooldown = this.cooldownMs;
      this.nextAttemptAt = now + this._currentCooldown;
    }
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Wraps fetch with circuit breaker protection and automatic retries.
 *
 * Retries up to `maxRetries` times with exponential backoff on 5xx or
 * network errors. Each failure is recorded against the circuit breaker —
 * if the breaker trips during retries, we bail out immediately.
 */
async function fetchWithResilience(url, options = {}, cbOptions = {}) {
  const breaker = fetchWithResilience._breaker ??= new CircuitBreaker(cbOptions);

  if (!breaker.canExecute()) {
    throw new Error('Circuit Breaker OPEN — service unavailable');
  }

  const maxRetries = 2;
  let backoff = 100;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, options);

      if (resp.status >= 500) {
        throw new Error(`Upstream error: ${resp.status}`);
      }

      breaker.onSuccess();
      return resp;
    } catch (err) {
      breaker.onFailure();

      if (breaker.state === 'OPEN') {
        throw new Error('Circuit Breaker OPEN — service unavailable');
      }

      if (attempt < maxRetries) {
        await sleep(backoff);
        backoff *= 2;
      } else {
        throw err;
      }
    }
  }
}

export { CircuitBreaker, fetchWithResilience };
