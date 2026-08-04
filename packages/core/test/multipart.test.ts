import { describe, expect, it } from 'vitest';
import { buildMultipartBody, parseMultipartBody } from '../src/multipart.js';

describe('buildMultipartBody', () => {
  it('round-trips a single part through the parser', () => {
    const manifest = JSON.stringify({ id: 'abc', assets: [] });
    const { body, boundary, contentType } = buildMultipartBody([
      { name: 'manifest', body: manifest },
    ]);

    expect(contentType).toBe(`multipart/mixed; boundary=${boundary}`);

    const parts = parseMultipartBody(body, boundary);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.name).toBe('manifest');
    expect(parts[0]?.body.toString('utf8')).toBe(manifest);
    expect(parts[0]?.headers['content-type']).toBe('application/json; charset=utf-8');
  });

  it('keeps per-part headers, which is where expo-signature must live', () => {
    const { body, boundary } = buildMultipartBody([
      { name: 'manifest', body: '{}', headers: { 'expo-signature': 'sig="abc", keyid="main"' } },
    ]);

    const parts = parseMultipartBody(body, boundary);
    expect(parts[0]?.headers['expo-signature']).toBe('sig="abc", keyid="main"');
  });

  it('round-trips multiple parts and preserves order', () => {
    const { body, boundary } = buildMultipartBody([
      { name: 'manifest', body: '{"a":1}' },
      { name: 'directive', body: '{"type":"rollBackToEmbedded"}' },
    ]);

    const parts = parseMultipartBody(body, boundary);
    expect(parts.map((part) => part.name)).toEqual(['manifest', 'directive']);
    expect(parts[1]?.body.toString('utf8')).toBe('{"type":"rollBackToEmbedded"}');
  });

  it('preserves binary bodies byte-for-byte', () => {
    // Bytes that would be mangled by any utf8 round-trip.
    const binary = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x2d, 0x2d, 0x80]);
    const { body, boundary } = buildMultipartBody([
      { name: 'blob', body: binary, contentType: 'application/octet-stream' },
    ]);

    const parts = parseMultipartBody(body, boundary);
    expect(parts[0]?.body.equals(binary)).toBe(true);
  });

  it('terminates with a closing delimiter', () => {
    const { body, boundary } = buildMultipartBody([{ name: 'manifest', body: '{}' }]);
    expect(body.toString('utf8').endsWith(`--${boundary}--\r\n`)).toBe(true);
  });

  it('refuses to build an empty body', () => {
    expect(() => buildMultipartBody([])).toThrow();
  });
});
