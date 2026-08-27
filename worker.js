// Tilly's Calculator — pricing sync Worker
// KV binding required: TILLYS_KV
// Secret required: TILLYS_PASSWORD_HASH (hex SHA-256 of the shared password)
//
// Endpoints:
//   POST /login    { password } -> { ok, key }        (key = sha256 hex of password, reused as the auth header value)
//   GET  /pricing   (X-Tillys-Key header)  -> stored pricing JSON, or null if never saved
//   PUT  /pricing   (X-Tillys-Key header, JSON body) -> saves pricing JSON

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Tillys-Key',
  };
}

async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function checkKey(request, env) {
  const key = request.headers.get('X-Tillys-Key') || '';
  return !!key && key === env.TILLYS_PASSWORD_HASH;
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
      if (hash === env.TILLYS_PASSWORD_HASH) {
        return new Response(JSON.stringify({ ok: true, key: hash }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
      }
      return new Response(JSON.stringify({ ok: false }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    if (url.pathname === '/pricing' && request.method === 'GET') {
      if (!checkKey(request, env)) return new Response('Unauthorized', { status: 401, headers: corsHeaders() });
      const data = await env.TILLYS_KV.get('pricing');
      return new Response(data || 'null', { headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
    }

    if (url.pathname === '/pricing' && request.method === 'PUT') {
      if (!checkKey(request, env)) return new Response('Unauthorized', { status: 401, headers: corsHeaders() });
      const body = await request.text();
      await env.TILLYS_KV.put('pricing', body);
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
    }

    return new Response('Not found', { status: 404, headers: corsHeaders() });
  },
};
