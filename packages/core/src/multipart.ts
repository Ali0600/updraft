import { randomBytes } from 'node:crypto';

const CRLF = '\r\n';

export interface MultipartPart {
  /** The `name` in the part's Content-Disposition — the protocol uses `manifest` / `directive`. */
  name: string;
  body: string | Buffer;
  contentType?: string;
  /** Extra part headers. The protocol puts `expo-signature` here, not on the response. */
  headers?: Record<string, string>;
}

export interface MultipartBody {
  boundary: string;
  contentType: string;
  body: Buffer;
}

export function generateBoundary(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Builds a `multipart/mixed` body. Written by hand rather than pulled from a
 * form-data library because the protocol needs per-part headers (the code
 * signature lives there) and exact byte control for signing.
 */
export function buildMultipartBody(
  parts: MultipartPart[],
  boundary = generateBoundary(),
): MultipartBody {
  if (parts.length === 0) {
    throw new Error('buildMultipartBody: at least one part is required');
  }

  const chunks: Buffer[] = [];
  for (const part of parts) {
    const headers: string[] = [`Content-Disposition: form-data; name="${part.name}"`];
    headers.push(`Content-Type: ${part.contentType ?? 'application/json; charset=utf-8'}`);
    for (const [key, value] of Object.entries(part.headers ?? {})) {
      headers.push(`${key}: ${value}`);
    }

    chunks.push(Buffer.from(`--${boundary}${CRLF}${headers.join(CRLF)}${CRLF}${CRLF}`, 'utf8'));
    chunks.push(Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body, 'utf8'));
    chunks.push(Buffer.from(CRLF, 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'));

  return {
    boundary,
    contentType: `multipart/mixed; boundary=${boundary}`,
    body: Buffer.concat(chunks),
  };
}

export interface ParsedPart {
  name: string | undefined;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Minimal parser, used by the conformance tests to prove what we emit is
 * actually parseable rather than merely plausible-looking.
 */
export function parseMultipartBody(body: Buffer, boundary: string): ParsedPart[] {
  const delimiter = Buffer.from(`--${boundary}`, 'utf8');
  const parts: ParsedPart[] = [];

  let index = body.indexOf(delimiter);
  while (index !== -1) {
    const afterDelimiter = index + delimiter.length;
    // Closing delimiter is `--boundary--`.
    if (body.subarray(afterDelimiter, afterDelimiter + 2).toString('utf8') === '--') break;

    const start = afterDelimiter + CRLF.length;
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;

    // Strip the CRLF that precedes the next delimiter.
    const raw = body.subarray(start, next - CRLF.length);
    const headerEnd = raw.indexOf(`${CRLF}${CRLF}`);
    if (headerEnd === -1) {
      index = next;
      continue;
    }

    const headers: Record<string, string> = {};
    for (const line of raw.subarray(0, headerEnd).toString('utf8').split(CRLF)) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }

    parts.push({
      name: parsePartName(headers['content-disposition']),
      headers,
      body: raw.subarray(headerEnd + CRLF.length * 2),
    });
    index = next;
  }

  return parts;
}

function parsePartName(contentDisposition: string | undefined): string | undefined {
  if (!contentDisposition) return undefined;
  return /name="([^"]*)"/.exec(contentDisposition)?.[1];
}
