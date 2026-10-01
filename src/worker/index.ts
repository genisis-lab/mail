/**
 * Cloudflare Workers entry point.
 *
 *   Browser ──► Worker ──► static assets (the web app)
 *                  └─────► /api/*  ──► WrenDurableObject (Hono app + SQLite)
 *   Email Routing ──► email() ──► WrenDurableObject.receiveEmail()
 *   Cron trigger  ──► scheduled() ──► WrenDurableObject.tick()
 *
 * A single SQLite-backed Durable Object holds the whole database, so every
 * request sees strongly consistent data with real transactions. Raw messages
 * and attachments live in R2 (or in the Durable Object itself if no bucket is
 * bound). Background work (send queue, snoozes, retention) runs on DO alarms.
 */
import { DurableObject } from 'cloudflare:workers';
import { EmailMessage } from 'cloudflare:email';
import type { Hono } from 'hono';
import { config, initConfig } from '../server/config.js';
import { getMeta, openDb, setMeta } from '../server/db/index.js';
import { setPlatform, type Platform } from '../server/platform.js';
import { createApp } from '../server/app.js';
import { dohResolver } from '../server/lib/doh.js';
import { logger } from '../server/lib/log.js';
import { nextWakeAt, runDueWork } from '../server/jobs.js';
import { recoverQueue } from '../server/mail/outbound.js';
import { ingest } from '../server/mail/ingest.js';
import type { AppEnv } from '../server/http/context.js';
import { verifyEncryptionKey } from '../server/services/backup.js';
import { doSqlDriver, r2BlobStore, sqlBlobStore } from './storage.js';
import { workersTcp } from './tcp.js';

export interface Env {
  WREN: DurableObjectNamespace;
  ASSETS: Fetcher;
  BLOBS?: R2Bucket;
  EMAIL?: SendEmail;
  WREN_SECRET?: string;
  PUBLIC_URL?: string;
  [key: string]: unknown;
}

const log = logger('worker');

function workersPlatform(ctx: DurableObjectState, env: Env, schedule: (at: number) => void): Platform {
  return {
    name: 'workers',
    blobs: env.BLOBS ? r2BlobStore(env.BLOBS) : sqlBlobStore(ctx.storage),
    dns: dohResolver(),
    tcp: workersTcp,
    env,
    clientIp: (c) => c.req.header('cf-connecting-ip') ?? '',
    databaseSize: () => ctx.storage.sql.databaseSize,
    systemInfo: () => ({
      platform: 'Cloudflare Workers · SQLite Durable Object',
      blobStorage: env.BLOBS ? 'R2 bucket' : 'Durable Object storage (bind an R2 bucket as BLOBS for large mailboxes)',
      emailBinding: !!env.EMAIL,
      secretFromEnv: !!env.WREN_SECRET,
    }),
    pointInTime: {
      current: () => ctx.storage.getCurrentBookmark(),
      at: (ts) => ctx.storage.getBookmarkForTime(ts),
      async restore(bookmark) {
        await ctx.storage.onNextSessionRestoreBookmark(bookmark);
        // Restart the object so the restore takes effect; let the response go out first.
        setTimeout(() => ctx.abort('Restoring database'), 250);
      },
    },
    wake: schedule,
    async sendViaBinding(binding, from, to, raw) {
      const b = env[binding] as SendEmail | undefined;
      if (!b?.send) throw new Error(`No send_email binding named ${binding}`);
      await b.send(new EmailMessage(from, to, new TextDecoder().decode(raw)));
    },
  };
}

/**
 * Without a WREN_SECRET binding, generate the encryption key once and keep it
 * in the Durable Object (like the Node build's data/.secret), so a deploy
 * needs no manual secret setup.
 */
function storedSecret(): string {
  const existing = getMeta('secret');
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = btoa(String.fromCharCode(...bytes));
  setMeta('secret', secret);
  return secret;
}

export class WrenDurableObject extends DurableObject<Env> {
  private app: Hono<AppEnv> | null = null;
  private setupError: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      try {
        setPlatform(workersPlatform(ctx, env, (at) => void this.schedule(at)));
        openDb(doSqlDriver(ctx.storage));
        initConfig(env, { platform: 'workers', secret: (env.WREN_SECRET as string | undefined) || storedSecret() });
        config.keyMismatch = !verifyEncryptionKey();
        recoverQueue();
        this.app = createApp();
      } catch (err) {
        this.setupError = (err as Error).message;
        log.error('Startup failed', err);
      }
    });
  }

  /** Make sure an alarm fires no later than `at` (or the next due job). */
  private async schedule(at?: number) {
    const next = Math.min(at ?? Infinity, nextWakeAt());
    const current = await this.ctx.storage.getAlarm();
    if (current === null || next < current || current < Date.now()) await this.ctx.storage.setAlarm(next);
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.app) {
      return Response.json({ error: `Wren failed to start: ${this.setupError}` }, { status: 500 });
    }
    // Zero-config public URL: unless PUBLIC_URL is set, use the origin users reach us at.
    if (!this.env.PUBLIC_URL) config.publicUrl = new URL(request.url).origin;
    const res = await this.app.fetch(request);
    this.ctx.waitUntil(this.schedule());
    return res;
  }

  async alarm() {
    if (!this.app) return;
    try {
      await runDueWork();
    } catch (err) {
      log.error('Background work failed', err);
    }
    await this.schedule();
  }

  /** Called by the Worker's email() handler for mail arriving through Email Routing. */
  async receiveEmail(raw: ArrayBuffer, from: string, to: string) {
    if (!this.app) throw new Error(this.setupError ?? 'not configured');
    const result = await ingest(Buffer.from(raw), { rcptTo: [to], mailFrom: from, source: 'cloudflare-routing' });
    await this.schedule();
    return { accepted: result.accepted, rejected: result.rejected };
  }

  /** Safety net from the cron trigger. */
  async tick() {
    await this.alarm();
  }
}

function stub(env: Env): DurableObjectStub {
  return env.WREN.get(env.WREN.idFromName('wren'));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) return stub(env).fetch(request);
    return env.ASSETS.fetch(request);
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const raw = await new Response(message.raw).arrayBuffer();
    const result = (await stub(env).receiveEmail(raw, message.from, message.to)) as {
      accepted: string[];
      rejected: { rcpt: string; reason: string }[];
    };
    if (!result.accepted.length) {
      message.setReject(`5.1.1 <${message.to}>: ${result.rejected[0]?.reason ?? 'no such user'}`);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(stub(env).tick());
  },
};
