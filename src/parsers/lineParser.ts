import type { ParsedLine } from '../types';

/** Bullet characters Billing uses in front of each buyer line. */
const BULLET_CHARS = '•·▪●◦*';

/**
 * Matches one entry line from either message format:
 *
 *   `• ZZY  - 67 + 25`      (Billing)
 *   `• NB48 - (-30) + 20`   (Billing, negative cap + top-up)
 *   `Q11 - 6`               (GRSTK statistics)
 *
 * Group 1 = bullet marker (Billing only), 2 = buyer code, 3 = expression.
 */
const LINE_RE = new RegExp(
  `^\\s*([${BULLET_CHARS}]|[-–—])?\\s*([A-Za-z][A-Za-z0-9_]{1,9})\\s*[-–—:]\\s*(\\S.*?)\\s*$`,
);

const BULLET_RE = new RegExp(`^[${BULLET_CHARS}]$`);

/** After normalisation an expression must look exactly like this. */
const EXPR_RE = /^[+-]?\d+([+-]\d+)*$/;

const TERM_RE = /[+-]?\d+/g;

/** Header words that syntactically look like a buyer code but aren't one. */
const RESERVED_CODES = new Set([
  'DATE',
  'TIME',
  'TOTAL',
  'TOTALS',
  'SUM',
  'NOTE',
  'NOTES',
  'BUYER',
  'BUYERS',
  'CAP',
  'CAPS',
  'UPDATE',
  'UPDATES',
  'STATS',
  'REPORT',
]);

/** `28-07-2026`, `28/07/26` — a date, not an arithmetic expression. */
const DATE_LIKE_RE = /^\s*\d{1,4}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{2,4}\s*$/;

export interface RawLineMatch {
  bulleted: boolean;
  line: ParsedLine;
}

/**
 * Evaluates a right-hand side such as `(-14) + 35` or `425 + 25`.
 *
 * Parentheses only ever wrap a negative number in these messages, so they can
 * be dropped before summing. Returns null when the text isn't a plain
 * addition/subtraction chain of integers.
 */
export function evaluateExpression(
  expression: string,
): { terms: number[]; total: number } | null {
  const normalised = expression
    .replace(/[−–—]/g, '-') // unicode minus / en dash / em dash
    .replace(/[()\[\]\s,]/g, '');

  if (!EXPR_RE.test(normalised)) return null;

  const matches = normalised.match(TERM_RE);
  if (!matches) return null;

  const terms = matches.map(Number);
  if (terms.some((t) => !Number.isSafeInteger(t))) return null;

  return { terms, total: terms.reduce((a, b) => a + b, 0) };
}

/** Parses a single line; returns null when the line isn't a buyer entry. */
export function parseLine(raw: string): RawLineMatch | null {
  const m = LINE_RE.exec(raw);
  if (!m) return null;

  const marker = m[1] ?? '';
  const code = (m[2] ?? '').toUpperCase();
  const expression = (m[3] ?? '').trim();

  if (RESERVED_CODES.has(code)) return null;
  if (DATE_LIKE_RE.test(expression)) return null;

  const evaluated = evaluateExpression(expression);
  if (!evaluated) return null;

  return {
    bulleted: BULLET_RE.test(marker),
    line: {
      code,
      terms: evaluated.terms,
      total: evaluated.total,
      expression,
      raw: raw.trim(),
    },
  };
}

/** Finds a `Date : 28-07-2026` style header anywhere in the message. */
export function findReportedDate(text: string): string | null {
  const m = /^\s*date\s*[:\-]\s*(.+?)\s*$/im.exec(text);
  return m && m[1] ? m[1].trim() : null;
}

/** True when a line looks like it was *meant* to be an entry (`CODE - ...`). */
export function looksLikeEntry(raw: string): boolean {
  const m = LINE_RE.exec(raw);
  if (!m) return false;
  const code = (m[2] ?? '').toUpperCase();
  if (RESERVED_CODES.has(code)) return false;
  return !DATE_LIKE_RE.test((m[3] ?? '').trim());
}
