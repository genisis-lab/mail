#!/usr/bin/env node
/**
 * Interactive setup from the terminal.
 *
 *   npm run setup                 # asks
 *   npm run setup -- cloudflare   # deploy to Cloudflare Workers (recommended)
 *   npm run setup -- docker       # self-host with Docker
 *   npm run setup -- local        # self-host without Docker (npm run serve)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

/** Run a command; with `capture`, also return its output (still shown live). */
function run(cmd, args, { capture = false, quiet = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit', env: process.env });
    let out = '';
    if (capture) {
      for (const s of [child.stdout, child.stderr]) {
        s.on('data', (d) => {
          out += d;
          if (!quiet) process.stdout.write(d);
        });
      }
    }
    child.on('exit', (code) => resolve({ code: code ?? 1, out }));
    child.on('error', () => resolve({ code: 127, out }));
  });
}

async function ask(question, fallback) {
  const answer = (await rl.question(`${question} ${fallback ? dim(`[${fallback}] `) : ''}`)).trim();
  return answer || fallback || '';
}

async function cloudflare() {
  console.log(`\n${bold('Deploying Wren to Cloudflare Workers')}\n`);

  const who = await run(npx, ['wrangler', 'whoami'], { capture: true, quiet: true });
  if (who.code !== 0 || /not authenticated|wrangler login/i.test(who.out)) {
    console.log('Sign in to Cloudflare in the browser window that opens…');
    if ((await run(npx, ['wrangler', 'login'])).code !== 0) throw new Error('Cloudflare sign-in failed.');
  } else {
    console.log(green('✓ Signed in to Cloudflare'));
  }

  const bucket = await run(npx, ['wrangler', 'r2', 'bucket', 'create', 'wren-mail'], { capture: true, quiet: true });
  if (bucket.code === 0 || /already exists|already own/i.test(bucket.out)) {
    console.log(green('✓ R2 bucket wren-mail is ready (message files and attachments)'));
  } else {
    console.log(bucket.out.trim());
    throw new Error('Could not create the R2 bucket. Enable R2 in the Cloudflare dashboard (the free tier is enough), then run setup again.');
  }

  console.log('\nBuilding and deploying…\n');
  const deploy = await run(npx, ['wrangler', 'deploy'], { capture: true });
  if (deploy.code !== 0) throw new Error('Deploy failed (see the output above).');
  const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(deploy.out)?.[0] ?? 'your Worker URL';

  console.log(`
${green('✓ Wren is live:')} ${bold(url)}

Next steps:
  1. Open ${url} and finish the setup wizard. Choose ${bold('Cloudflare Email Service')} to send.
  2. Cloudflare dashboard → your domain → ${bold('Email → Email Routing')}: enable it, then
     Routing rules → Catch-all → ${bold('Send to a Worker → wren')}. That's how mail comes in.
  3. Cloudflare dashboard → ${bold('Email Service → Email Sending')}: onboard your domain so Wren can send.
  4. Optional: Workers → wren → Settings → Domains & Routes → add mail.yourdomain.com.

Using Resend instead? Pick Resend in the wizard and paste your API key.
`);
}

async function docker() {
  console.log(`\n${bold('Self-hosting Wren with Docker')}\n`);
  if ((await run('docker', ['compose', 'version'], { capture: true, quiet: true })).code !== 0) {
    throw new Error('Docker (with the compose plugin) is not installed. See https://docs.docker.com/get-docker/ or use `npm run setup -- local`.');
  }
  const publicUrl = await ask('Public URL people will use (for provider webhooks):', 'http://localhost:8787');
  const proxy = /^y/i.test(await ask('Is a reverse proxy (Caddy, nginx…) in front of it? (y/N)', 'n'));
  const envFile = path.join(root, '.env');
  if (!fs.existsSync(envFile) || /^y/i.test(await ask('.env exists. Overwrite it? (y/N)', 'n'))) {
    fs.writeFileSync(envFile, `PUBLIC_URL=${publicUrl}\nTRUST_PROXY=${proxy ? 1 : 0}\n`);
    console.log(green('✓ Wrote .env'));
  }
  if ((await run('docker', ['compose', 'up', '-d', '--build'])).code !== 0) throw new Error('docker compose failed (see the output above).');
  console.log(`
${green('✓ Wren is running:')} ${bold(publicUrl)}  ${dim('(data in ./data)')}

Self-hosted Wren sends and receives through a provider. In the setup wizard choose
${bold('Resend')} and paste your API key. For incoming mail, add Resend's inbound webhook:
Admin → Providers → Resend shows the URL to paste into Resend.
`);
}

async function local() {
  console.log(`\n${bold('Self-hosting Wren without Docker')}\n`);
  console.log(`Runs the same Worker on this machine with workerd. Data goes to ./data.
Start it any time with:  ${bold('npm run serve')}   ${dim('(PORT, PUBLIC_URL, DATA_DIR, TRUST_PROXY)')}
`);
  if (/^y/i.test(await ask('Start it now? (Y/n)', 'y'))) {
    rl.close();
    await run(process.execPath, [path.join(root, 'scripts/serve.mjs')]);
  }
}

async function main() {
  console.log(`${bold('Wren setup')}  ${dim('Gmail-style mail for your own domains')}`);
  let mode = process.argv[2];
  if (!mode) {
    console.log(`
How do you want to run Wren?
  ${bold('1')}  Cloudflare Workers ${green('(recommended)')}  no server, sends with Cloudflare Email Service
  ${bold('2')}  Docker on your own server
  ${bold('3')}  Your own machine without Docker
`);
    mode = { 1: 'cloudflare', 2: 'docker', 3: 'local' }[await ask('Choose 1, 2 or 3:', '1')] ?? 'cloudflare';
  }
  if (mode === 'cloudflare') await cloudflare();
  else if (mode === 'docker') await docker();
  else if (mode === 'local') await local();
  else throw new Error(`Unknown option "${mode}". Use cloudflare, docker or local.`);
}

main()
  .catch((err) => {
    console.error(`\n✗ ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
