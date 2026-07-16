/**
 * /api/chat — Anthropic API proxy
 * Deployed as a Vercel Edge Function.
 * The ANTHROPIC_API_KEY env var never reaches the browser.
 */

export const config = { runtime: 'edge' };

const RATE_LIMIT = new Map();

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
}

  // Simple rate-limit: 30 req/min per IP
  const ip  = req.headers.get('x-forwarded-for') || 'unknown';
  const now = Date.now();
  const rl  = RATE_LIMIT.get(ip) || { count: 0, reset: now + 60000 };
  if (now > rl.reset) { rl.count = 0; rl.reset = now + 60000; }
  rl.count++;
  RATE_LIMIT.set(ip, rl);
  if (rl.count > 30) {
    return new Response(JSON.stringify({ error: 'Too many requests' }), {
      status: 429, headers: { 'Content-Type': 'application/json' }
});
}

  const body = await req.json();
  const safe = {
    model:      body.model      || 'claude-sonnet-4-20250514',
    max_tokens: Math.min(body.max_tokens || 1000, 2000),
    messages:   (body.messages  || []).slice(-20),
    system:     body.system     || undefined,
};

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
},
    body: JSON.stringify(safe),
});

  const data = await upstream.text();
  return new Response(data, {
    status:  upstream.status,
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': 'no-store',
},
});
}
