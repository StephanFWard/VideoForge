/**
 * Tiny dependency-free logger with optional colour and an event sink, so the
 * web UI and the CLI can both render the same run.
 */

const COLOURS = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
};

export function createLogger({ name = 'video-forge', silent = false, onEvent } = {}) {
  const t0 = Date.now();
  const useColour = !silent && process.stdout?.isTTY === true;

  const paint = (colour, text) => (useColour ? `${COLOURS[colour]}${text}${COLOURS.reset}` : text);
  const stamp = () => `+${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(6)}s`;

  function emit(level, message, meta) {
    if (onEvent) {
      try {
        onEvent({ level, message, meta, at: new Date().toISOString() });
      } catch {
        /* a broken sink must never kill a render */
      }
    }
    if (silent) return;

    const palette = {
      info: 'cyan',
      step: 'magenta',
      ok: 'green',
      warn: 'yellow',
      error: 'red',
      debug: 'dim',
    };
    const label = level === 'step' ? '▶' : level === 'ok' ? '✔' : level === 'warn' ? '!' : level === 'error' ? '✖' : '·';
    const line = `${paint('dim', stamp())} ${paint(palette[level] ?? 'cyan', label)} ${message}`;
    const stream = level === 'error' ? console.error : console.log;
    stream(line);
    if (meta && (level === 'warn' || level === 'error')) {
      stream(paint('dim', `    ${typeof meta === 'string' ? meta : JSON.stringify(meta)}`));
    }
  }

  return {
    name,
    info: (m, meta) => emit('info', m, meta),
    step: (m, meta) => emit('step', m, meta),
    ok: (m, meta) => emit('ok', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    debug: (m, meta) => emit('debug', m, meta),
    child(scope) {
      const scoped = createLogger({ name: `${name}:${scope}`, silent, onEvent });
      scoped.info = (m, meta) => emit('info', `[${scope}] ${m}`, meta);
      scoped.step = (m, meta) => emit('step', `[${scope}] ${m}`, meta);
      scoped.ok = (m, meta) => emit('ok', `[${scope}] ${m}`, meta);
      scoped.warn = (m, meta) => emit('warn', `[${scope}] ${m}`, meta);
      scoped.error = (m, meta) => emit('error', `[${scope}] ${m}`, meta);
      return scoped;
    },
    elapsed: () => (Date.now() - t0) / 1000,
  };
}

export default createLogger;
