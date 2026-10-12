import type { OutboxLease, StatefulStore } from './postgres.js';

export interface EmailSender { send(payload: unknown, idempotencyKey: string): Promise<string> }
export class DeliveryError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); this.name = 'DeliveryError'; }
}

export class ResendSender implements EmailSender {
  constructor(private apiKey: string) {}
  async send(payload: unknown, idempotencyKey: string): Promise<string> {
    const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: {
      authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey,
    }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
    const body = await response.json().catch(() => ({})) as { id?: string; message?: string; name?: string };
    if (!response.ok || !body.id) {
      const retryable = response.status === 409 && body.name === 'concurrent_idempotent_requests' || response.status === 429 || response.status >= 500;
      throw new DeliveryError(`Resend ${response.status}: ${body.message ?? 'delivery failed'}`, retryable);
    }
    return body.id;
  }
}

export async function deliverOne(store: StatefulStore, sender: EmailSender, workerId: string): Promise<boolean> {
  const lease = await store.claimEmail(workerId, 60);
  if (!lease) return false;
  try {
    // The same key and byte-equivalent JSON payload are reused after ambiguous failures.
    const providerId = await sender.send(lease.payload, lease.idempotencyKey);
    await store.emailSent(lease, providerId);
  } catch (error) {
    if (error instanceof DeliveryError && !error.retryable) await store.emailFailed(lease, error.message);
    else {
      const backoff = Math.min(3600, 2 ** Math.min(lease.attempt, 10));
      await store.emailRetry(lease, (error as Error).message, backoff);
    }
  }
  return true;
}

export type { OutboxLease };
