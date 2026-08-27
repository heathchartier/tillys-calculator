// Tilly's Calculator — pricing sync Worker
// KV binding required: TILLYS_KV
// Secret required: TILLYS_PASSWORD_HASH (hex SHA-256 of the shared password) — used only as the
//   initial/fallback password before anyone has changed it via the app. Once a password change
//   happens, the live hash lives in KV under the "auth_hash" key and the secret is ignored.
//
// Endpoints:
//   POST /login            { password } -> { ok, key }   (key = sha256 hex of password, reused as the auth header value)
//   GET  /pricing           (X-Tillys-Key header)  -> stored pricing JSON, or null if never saved
//   PUT  /pricing           (X-Tillys-Key header, JSON body) -> saves pricing JSON
//   GET  /requests          (X-Tillys-Key header)  -> stored saved-requests JSON array, or [] if never saved
//   PUT  /requests          (X-Tillys-Key header, JSON body) -> saves the saved-requests array (cross-device sync)
//   POST /change-password   (X-Tillys-Key header, { newPassword }) -> sets a new password, returns { ok, key }

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Tillys-Key',
  };
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function getAuthHash(env) {
  const stored = await env.TILLYS_KV.get('auth_hash');
  return stored || env.TILLYS_PASSWORD_HASH;
}

async function checkKey(request, env) {
  const key = request.headers.get('X-Tillys-Key') || '';
  if (!key) return false;
  const authHash = await getAuthHash(env);
  return key === authHash;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === '/login' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const hash = await sha256Hex(body.password || '');
      const authHash = await getAuthHash(env);
      if (hash === authHash) return json({ ok: true, key: hash });
      return json({ ok: false }, 401);
    }

    if (url.pathname === '/change-password' && request.method === 'POST') {
      if (!(await checkKey(request, env))) return new Response('Unauthorized', { status: 401, headers: corsHeaders() });
      const body = await request.json().catch(() => ({}));
      const newPassword = body.newPassword || '';
      if (newPassword.length < 6) return json({ ok: false, error: 'Password must be at least 6 characters.' }, 400);
      const newHash = await sha256Hex(newPassword);
      await env.TILLYS_KV.put('auth_hash', newHash);
      return json({ ok: true, key: newHash });
    }

    if (url.pathname === '/pricing' && request.method === 'GET') {
      if (!(await checkKey(request, env))) return new Response('Unauthorized', { status: 401, headers: corsHeaders() });
      const data = await env.TILLYS_KV.get('pricing');
      return new Response(data || 'null', { headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
    }

    if (url.pathname === '/pricing' && request.method === 'PUT') {
      if (!(await checkKey(request, env))) return new Response('Unauthorized', { status: 401, headers: corsHeaders() });
      const body = await request.text();
      await env.TILLYS_KV.put('pricing', body);
      return json({ ok: true });
    }

    if (url.pathname === '/requests' && request.method === 'GET') {
      if (!(await checkKey(request, env))) return new Response('Unauthorized', { status: 401, headers: corsHeaders() });
      const data = await env.TILLYS_KV.get('saved_requests');
      return new Response(data || '[]', { headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
    }

    if (url.pathname === '/requests' && request.method === 'PUT') {
      if (!(await checkKey(request, env))) return new Response('Unauthorized', { status: 401, headers: corsHeaders() });
      const body = await request.text();
      await env.TILLYS_KV.put('saved_requests', body);
      return json({ ok: true });
    }

    return new Response('Not found', { status: 404, headers: corsHeaders() });
  },
};
