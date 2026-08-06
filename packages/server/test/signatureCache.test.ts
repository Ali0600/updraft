import { describe, expect, it } from 'vitest';
import { createMemoizer } from '../src/services/signatureCache.js';

describe('createMemoizer', () => {
  it('computes once per distinct body and reuses the result', () => {
    // The whole point of the fix: a repeated body must not repeat the RSA
    // operation. Output alone cannot show this — a counting compute can.
    let calls = 0;
    const memo = createMemoizer((body) => {
      calls += 1;
      return `sig(${body})`;
    });

    expect(memo('a')).toBe('sig(a)');
    expect(memo('a')).toBe('sig(a)');
    expect(memo('a')).toBe('sig(a)');
    expect(calls).toBe(1);

    expect(memo('b')).toBe('sig(b)');
    expect(calls).toBe(2);
  });

  it('evicts oldest-first past the bound, so churn cannot leak', () => {
    let calls = 0;
    const memo = createMemoizer((body) => {
      calls += 1;
      return body;
    }, 2);

    memo('a'); // cache: [a]
    memo('b'); // cache: [a, b]
    memo('c'); // over bound → evict a → cache: [b, c]
    expect(calls).toBe(3);

    memo('c'); // still cached
    memo('b'); // still cached
    expect(calls).toBe(3);

    memo('a'); // was evicted → recomputes
    expect(calls).toBe(4);
  });
});
