// Google sign-in: verifies the ID token the page gets from Google Identity Services.
// Checked locally with Google's public keys (no call to Google per request, unlike Apps Script's
// tokeninfo); keys are cached until Google's Cache-Control says they expire.

export interface GoogleUser { sub: string; email: string; name: string }

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let keyCache: { until: number; keys: Map<string, CryptoKey> } | null = null;

function b64urlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}
function b64urlJson(s: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
}

async function googleKeys(fetcher: typeof fetch): Promise<Map<string, CryptoKey>> {
  if (keyCache && keyCache.until > Date.now()) return keyCache.keys;
  const res = await fetcher(CERTS_URL);
  if (!res.ok) throw new Error('SIGNIN_UNAVAILABLE');
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1] || 3600);
  const body = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys) {
    keys.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  keyCache = { until: Date.now() + maxAge * 1000, keys };
  return keys;
}

/** Returns the signed-in user, or throws SIGNIN_EXPIRED (the page then asks the rider to sign in again). */
export async function verifyGoogleIdToken(token: unknown, clientId: string, fetcher: typeof fetch = fetch): Promise<GoogleUser> {
  if (typeof token !== 'string' || !token) throw new Error('Please sign in.');
  const parts = token.split('.');
  if (parts.length !== 3 || token.length > 4096) throw new Error('SIGNIN_EXPIRED');
  const header = b64urlJson(parts[0]);
  const claims = b64urlJson(parts[1]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('SIGNIN_EXPIRED');
  const key = (await googleKeys(fetcher)).get(header.kid);
  if (!key) { keyCache = null; throw new Error('SIGNIN_EXPIRED'); }   // keys rotated: refetch next time
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1]));
  const issuerOk = claims.iss === 'accounts.google.com' || claims.iss === 'https://accounts.google.com';
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (!ok || claims.aud !== clientId || !issuerOk || !verified || Number(claims.exp) * 1000 < Date.now()) {
    throw new Error('SIGNIN_EXPIRED');
  }
  return { sub: String(claims.sub), email: String(claims.email || ''), name: String(claims.name || '') };
}
