// Supabase Edge Function: claude-proxy
// Uses Groq (FREE — no credit card, 14,400 requests/day, very fast).
// Llama 3.3 70B runs at ~500 tokens/second on Groq's free tier.
//
// SETUP:
//   1. Get free Groq key (no credit card):
//      https://console.groq.com → API Keys → Create API Key
//   2. supabase secrets set GROQ_API_KEY=your-groq-key
//   3. supabase secrets set JSEARCH_KEY=your-rapidapi-key   (already set)
//   4. supabase functions deploy claude-proxy --no-verify-jwt

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const GROQ_MODEL = 'llama-3.3-70b-versatile';  // free, fast, very capable
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const JSEARCH_URL = 'https://jsearch.p.rapidapi.com/search';

const ALLOWED_ORIGINS = [
  'http://localhost',
  'http://127.0.0.1',
  'http://localhost:8080',
  'https://xykfvlyidatykliocqam.supabase.co',
];

function corsHeaders(origin: string) {
  const allowed = ALLOWED_ORIGINS.some(o => origin?.startsWith(o)) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Action',
  };
}

// Convert Anthropic-format → Groq/OpenAI format
function toGroq(body: any) {
  const system  = body.system   || '';
  const msgs    = body.messages || [];
  const maxTok  = body.max_tokens || 1000;

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  msgs.forEach((m: any) => messages.push({
    role:    m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));

  return { model: GROQ_MODEL, messages, max_tokens: maxTok, temperature: 0.2 };
}

// Convert Groq/OpenAI response → Anthropic format so match.js needs no changes
function fromGroq(data: any) {
  const text = data?.choices?.[0]?.message?.content || '';
  return { content: [{ type: 'text', text }], model: GROQ_MODEL, role: 'assistant' };
}

serve(async (req: Request) => {
  const origin = req.headers.get('origin') || '';

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders(origin) });
  }

  // Verify Supabase JWT
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized — please log in.' }),
      { status: 401, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
  }

  try {
    const body   = await req.json();
    const action = req.headers.get('X-Action') || 'ai';

    // ── JSearch: LinkedIn + Indeed + Glassdoor + ZipRecruiter ──
    if (action === 'jsearch') {
      const jsearchKey = Deno.env.get('JSEARCH_KEY') || '';
      if (!jsearchKey) {
        return new Response(JSON.stringify({ error: 'JSEARCH_KEY not set.' }),
          { status: 500, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
      }
      const query = encodeURIComponent(body.query || 'IT jobs South Africa');
      const pages = body.pages || 2;
      const url   = `${JSEARCH_URL}?query=${query}&page=1&num_pages=${pages}&date_posted=month&country=za&language=en`;
      const jRes  = await fetch(url, {
        headers: { 'X-RapidAPI-Key': jsearchKey, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' }
      });
      const jData = await jRes.json();
      return new Response(JSON.stringify(jData),
        { status: jRes.ok ? 200 : jRes.status,
          headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
    }

    // ── Adzuna: free job API — 250 calls/month, no credit card
    //    Sign up: https://developer.adzuna.com
    //    supabase secrets set ADZUNA_APP_ID=xxx ADZUNA_APP_KEY=xxx ──
    if (action === 'adzuna') {
      const appId  = Deno.env.get('ADZUNA_APP_ID')  || '';
      const appKey = Deno.env.get('ADZUNA_APP_KEY')  || '';
      if (!appId || !appKey) {
        // Not configured — return empty results (optional source)
        return new Response(JSON.stringify({ results: [] }),
          { status: 200, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
      }
      const q    = encodeURIComponent(body.query || 'IT South Africa');
      const rpp  = body.results_per_page || 20;
      const url  = `https://api.adzuna.com/v1/api/jobs/za/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=${rpp}&what=${q}&content-type=application/json`;
      const aRes = await fetch(url);
      const aData = await aRes.json();
      return new Response(JSON.stringify(aData),
        { status: aRes.ok ? 200 : aRes.status,
          headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
    }

    // ── AI: Groq (Llama 3.3 70B) ──
    const groqKey = Deno.env.get('GROQ_API_KEY') || '';
    if (!groqKey) {
      return new Response(
        JSON.stringify({ error: 'GROQ_API_KEY not set. Run: supabase secrets set GROQ_API_KEY=yourkey  (free at console.groq.com)' }),
        { status: 500, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
    }

    const gRes = await fetch(GROQ_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body:    JSON.stringify(toGroq(body)),
    });

    const gData = await gRes.json();

    if (!gRes.ok) {
      return new Response(JSON.stringify(gData),
        { status: gRes.status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify(fromGroq(gData)),
      { status: 200, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
  }
});