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
import { all, openDb } from '../server/db/index.js';
import { setPlatform, type Platform } from '../server/platform.js';
import { createApp } from '../server/app.js';
import { dohResolver } from '../server/lib/doh.js';
import { logger } from '../server/lib/log.js';
import { nextWakeAt, runDueWork } from '../server/jobs.js';
import { recoverQueue } from '../server/mail/outbound.js';
import { ingest } from '../server/mail/ingest.js';
import type { AppEnv } from '../server/http/context.js';
import { doSqlDriver, r2BlobStore, sqlBlobStore } from './storage.js';

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
    env,
    clientIp: (c) => c.req.header('cf-connecting-ip') ?? '',
    databaseSize: () => ctx.storage.sql.databaseSize,
    systemInfo: () => ({
      platform: 'Cloudflare Workers · SQLite Durable Object',
      blobStorage: env.BLOBS ? 'R2 bucket' : 'Durable Object storage (bind an R2 bucket as BLOBS for large mailboxes)',
      emailBinding: !!env.EMAIL,
      secretFromEnv: true,
    }),
    async backup() {
      // Durable Objects have point-in-time recovery; this export is a portable JSON copy.
      const tables = all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'messages_fts%' AND name != '_blobs'`,
      );
      const dump: Record<string, unknown[]> = {};
      for (const t of tables) dump[t.name] = all(`SELECT * FROM "${t.name}"`);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      return {
        data: new TextEncoder().encode(JSON.stringify({ format: 'wren-export-v1', exportedAt: Date.now(), tables: dump })),
        filename: `wren-${stamp}.json`,
        contentType: 'application/json',
      };
    },
    wake: schedule,
    async sendViaBinding(binding, from, to, raw) {
      const b = env[binding] as SendEmail | undefined;
      if (!b?.send) throw new Error(`No send_email binding named ${binding}`);
      await b.send(new EmailMessage(from, to, new TextDecoder().decode(raw)));
    },
  };
}

export class WrenDurableObject extends DurableObject<Env> {
  private app: Hono<AppEnv> | null = null;
  private setupError: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    try {
      initConfig(env, { platform: 'workers' });
    } catch (err) {
      this.setupError = (err as Error).message;
      return;
    }
    setPlatform(workersPlatform(ctx, env, (at) => void this.schedule(at)));
    ctx.blockConcurrencyWhile(async () => {
      openDb(doSqlDriver(ctx.storage));
      recoverQueue();
    });
    this.app = createApp();
  }

  /** Make sure an alarm fires no later than `at` (or the next due job). */
  private async schedule(at?: number) {
    const next = Math.min(at ?? Infinity, nextWakeAt());
    const current = await this.ctx.storage.getAlarm();
    if (current === null || next < current || current < Date.now()) await this.ctx.storage.setAlarm(next);
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.app) {
      return Response.json({ error: `Wren is not configured: ${this.setupError}. Run \`npx wrangler secret put WREN_SECRET\`.` }, { status: 500 });
    }
    // Zero-config public URL: unless PUBLIC_URL is set, use the origin users reach us at.
    if (!this.env.PUBLIC_URL) config.publicUrl = new URL(request.url).origin;
    const res = await this.app.fetch(request);
    this.ctx.waitUntil(this.schedule());
    return res;
  }

  async alarm() {
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
    if (!this.app) return;
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
