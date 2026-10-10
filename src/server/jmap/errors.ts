/** A JMAP method-level error (RFC 8620 3.6.2), returned as ["error", {type, …}, callId]. */
export class MethodError extends Error {
  constructor(
    readonly type: string,
    description?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(description ?? type);
  }

  toJSON() {
    return { type: this.type, ...(this.message && this.message !== this.type ? { description: this.message } : {}), ...this.extra };
  }
}

/** A per-record error in a /set response (notCreated, notUpdated, notDestroyed). */
export class SetError extends Error {
  constructor(
    readonly type: string,
    description?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(description ?? type);
  }

  toJSON() {
    return { type: this.type, ...(this.message && this.message !== this.type ? { description: this.message } : {}), ...this.extra };
  }
}

/** Turn anything a /set record threw into a SetError (Wren's own HTTP errors carry a readable message). */
export function asSetError(err: unknown): SetError {
  if (err instanceof SetError) return err;
  const status = (err as { status?: number }).status;
  const message = (err as Error)?.message ?? 'Something went wrong';
  if (status === 404) return new SetError('notFound', message);
  if (status === 403) return new SetError('forbidden', message);
  if (status === 429) return new SetError('rateLimit', message);
  if (status && status < 500) return new SetError('invalidProperties', message);
  return new SetError('serverFail', 'Something went wrong on the server');
}

/** A request-level problem (RFC 8620 3.6.1, RFC 7807 problem details). A bare name is one of JMAP's own types. */
export function problem(type: string, detail: string, status = 400, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ type: type.includes(':') ? type : `urn:ietf:params:jmap:error:${type}`, status, detail, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}
