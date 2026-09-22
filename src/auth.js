// Identifies the signed-in person from Cloudflare Access (Google sign-in).
// Access adds a signed token to every request; verifying it here means the
// API can never be reached without a valid Promtek login.
import { createRemoteJWKSet, jwtVerify } from 'jose';

let jwks = null;
let jwksUrl = null;

function tokenFrom(request) {
  const header = request.headers.get('cf-access-jwt-assertion');
  if (header) return header;
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? match[1] : null;
}

export async function getUser(request, env) {
  let email = null;

  if (env.DEV_EMAIL) {
    // Local development only (set in .dev.vars). Never set this in production.
    email = env.DEV_EMAIL;
  } else {
    const token = tokenFrom(request);
    if (!token) return null;
    const url = `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
    if (!jwks || jwksUrl !== url) {
      jwks = createRemoteJWKSet(new URL(url));
      jwksUrl = url;
    }
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: env.ACCESS_TEAM_DOMAIN,
        audience: env.ACCESS_AUD,
      });
      email = payload.email;
    } catch (err) {
      console.warn('Access token rejected:', err.message);
      return null;
    }
  }

  if (!email) return null;
  email = email.toLowerCase();
  if (!email.endsWith('@' + env.ALLOWED_EMAIL_DOMAIN.toLowerCase())) return null;

  const admins = (env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return { email, isAdmin: admins.includes(email) };
}
