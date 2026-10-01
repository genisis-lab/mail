type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const env = (typeof process !== 'undefined' && process.env) || {};
let threshold = order[(env.LOG_LEVEL as Level) || 'info'] ?? 20;
let silent = !!env.WREN_SILENT;

export function configureLogging(opts: { level?: string; silent?: boolean }) {
  if (opts.level && opts.level in order) threshold = order[opts.level as Level];
  if (opts.silent !== undefined) silent = opts.silent;
}

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (order[level] < threshold || silent) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (extra !== undefined) fn(line, extra instanceof Error ? extra.message : extra);
  else fn(line);
}

export function logger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => emit('debug', scope, msg, extra),
    info: (msg: string, extra?: unknown) => emit('info', scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit('warn', scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit('error', scope, msg, extra),
  };
}
