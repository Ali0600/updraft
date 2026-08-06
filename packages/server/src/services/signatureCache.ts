/**
 * Memoizes a pure string→string function with a bounded cache.
 *
 * The manifest endpoint is unauthenticated and the device paths are
 * deliberately unrate-limited, so a request that merely asks for a signature
 * forces an RSA operation for free. The signed bytes are deterministic per
 * update (and RSASSA-PKCS1-v1_5 is itself deterministic), so the result can be
 * cached: identical output, one signing operation per distinct body.
 *
 * The cache is bounded and evicts oldest-first, so churn across many updates
 * cannot leak — a hot body is simply recomputed once if it was evicted.
 */
export function createMemoizer(
  compute: (body: string) => string,
  max = 256,
): (body: string) => string {
  const cache = new Map<string, string>();

  return (body: string): string => {
    const cached = cache.get(body);
    if (cached !== undefined) return cached;

    const value = compute(body);
    if (cache.size >= max) {
      // Map preserves insertion order, so the first key is the oldest.
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(body, value);
    return value;
  };
}
