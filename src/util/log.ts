const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

let threshold = 1; // info

export function setLogLevel(level: string): void {
  const i = LEVELS.indexOf(level as Level);
  if (i >= 0) threshold = i;
}

function emit(level: Level, args: unknown[]): void {
  if (LEVELS.indexOf(level) < threshold) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)}`;
  if (level === 'error') console.error(line, ...args);
  else if (level === 'warn') console.warn(line, ...args);
  else console.log(line, ...args);
}

export const log = {
  debug: (...a: unknown[]) => emit('debug', a),
  info: (...a: unknown[]) => emit('info', a),
  warn: (...a: unknown[]) => emit('warn', a),
  error: (...a: unknown[]) => emit('error', a),
};
