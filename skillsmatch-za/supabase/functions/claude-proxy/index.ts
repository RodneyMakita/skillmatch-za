// Supabase Edge Function: claude-proxy
// AI: Groq (free) — console.groq.com
// Jobs: Adzuna SA (free 250/month) + Reed.co.uk (free 250/month)
//       Both have real SA jobs with working direct apply links.
//
// SETUP:
//   supabase secrets set GROQ_API_KEY=gsk_your-key
//   supabase secrets set ADZUNA_APP_ID=xxx   (developer.adzuna.com — free)
//   supabase secrets set ADZUNA_APP_KEY=xxx
//   supabase secrets set REED_API_KEY=xxx    (reed.co.uk/developers — free)
//   supabase functions deploy claude-proxy --no-verify-jwt

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';

function cors(origin: string) {
  return {
    'Access-Control-Allow-Origin':  origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Action',
  };
}

function json(data: any, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status, headers: { ...cors(origin), 'Content-Type': 'application/json' }
  });
}

function toGroq(body: any) {
  const msgs: any[] = [];
  if (body.system) msgs.push({ role: 'system', content: body.system });
  (body.messages || []).forEach((m: any) => msgs.push({
    role:    m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));
  return { model: GROQ_MODEL, messages: msgs, max_tokens: body.max_tokens || 1000, temperature: 0.2 };
}

// ── Adzuna SA ─────────────────────────────────────────────────
async function adzuna(keywords: string, province: string, appId: string, appKey: string) {
  const kw  = encodeURIComponent(keywords);
  const loc = province && province !== 'South Africa' ? `&where=${encodeURIComponent(province)}` : '';
  const url = `https://api.adzuna.com/v1/api/jobs/za/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=20&what=${kw}${loc}&content-type=application/json&sort_by=date`;
  const r   = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) { console.warn('Adzuna', r.status, await r.text()); return []; }
  const d = await r.json();
  return (d.results || []).map((j: any) => ({
    title:        j.title || '',
    company:      j.company?.display_name || '',
    location:     j.location?.display_name || province,
    description:  (j.description || '').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,600),
    apply_url:    j.redirect_url || null,
    source:       'adzuna',
    closing_date: null,
    is_remote:    /remote/i.test((j.title||'') + (j.description||'')),
    stipend:      j.salary_min ? `R${Math.round(j.salary_min)}–R${Math.round(j.salary_max||j.salary_min)}/year` : null,
  })).filter((j:any) => j.apply_url && j.title);
}

// ── Reed.co.uk SA jobs ────────────────────────────────────────
async function reed(keywords: string, province: string, apiKey: string) {
  const kw   = encodeURIComponent(keywords + ' South Africa');
  const url  = `https://www.reed.co.uk/api/1.0/search?keywords=${kw}&location=${encodeURIComponent(province || 'South Africa')}&distancefromlocation=50&resultsToTake=20`;
  const auth = 'Basic ' + btoa(apiKey + ':');
  const r    = await fetch(url, { headers: { 'Authorization': auth }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) { console.warn('Reed', r.status); return []; }
  const d = await r.json();
  return (d.results || []).map((j: any) => ({
    title:        j.jobTitle  || '',
    company:      j.employerName || '',
    location:     j.locationName || province,
    description:  (j.jobDescription || '').replace(/<[^>]+>/g,' ').trim().slice(0,600),
    apply_url:    j.jobUrl   || null,
    source:       'reed',
    closing_date: j.expirationDate ? j.expirationDate.slice(0,10) : null,
    is_remote:    j.locationName === 'Remote' || /remote/i.test(j.jobTitle||''),
    stipend:      j.minimumSalary ? `R${Math.round(j.minimumSalary)}–R${Math.round(j.maximumSalary||j.minimumSalary)}/year` : null,
  })).filter((j:any) => j.apply_url && j.title);
}

serve(async (req: Request) => {
  const origin = req.headers.get('origin') || '';
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== 'POST')    return new Response('Method not allowed', { status: 405, headers: cors(origin) });

  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401, origin);

  try {
    const body   = await req.json();
    const action = req.headers.get('X-Action') || 'ai';

    // ── Job fetch ──────────────────────────────────────────
    if (action === 'jobs') {
      // Build keywords from whatever the client sends — never hardcode a default.
      // match.js sends: keywords (pre-built phrase), field, skills[]
      // We combine them so any discipline works: engineering, health, finance, etc.
      const field     = (body.field || '').trim();
      const skills    = Array.isArray(body.skills) ? body.skills.slice(0,5).join(' ') : '';
      const raw       = (body.keywords || body.query || '').trim();
      const keywords  = raw || [field, skills].filter(Boolean).join(' ') || 'learnership South Africa';
      const province  = body.province || 'South Africa';
      console.log('[jobs] keywords:', keywords, '| province:', province);
      const adzunaId  = Deno.env.get('ADZUNA_APP_ID')  || '';
      const adzunaKey = Deno.env.get('ADZUNA_APP_KEY') || '';
      const reedKey   = Deno.env.get('REED_API_KEY')   || '';

      if (!adzunaId && !reedKey) {
        return json({
          data: [], count: 0,
          warning: 'No job API keys set. Add ADZUNA_APP_ID+ADZUNA_APP_KEY (developer.adzuna.com) or REED_API_KEY (reed.co.uk/developers) — both free.'
        }, 200, origin);
      }

      const [adzunaJobs, reedJobs] = await Promise.allSettled([
        adzunaId && adzunaKey ? adzuna(keywords, province, adzunaId, adzunaKey) : Promise.resolve([]),
        reedKey               ? reed(keywords, province, reedKey)               : Promise.resolve([]),
      ]);

      const all = [
        ...(adzunaJobs.status === 'fulfilled' ? adzunaJobs.value : []),
        ...(reedJobs.status   === 'fulfilled' ? reedJobs.value   : []),
      ];

      // Deduplicate by title+company
      const seen = new Set<string>();
      const deduped = all.filter((j: any) => {
        const k = `${(j.title||'').toLowerCase()}|${(j.company||'').toLowerCase()}`;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });

      console.log(`Jobs: Adzuna=${adzunaJobs.status==='fulfilled'?adzunaJobs.value.length:'err'} Reed=${reedJobs.status==='fulfilled'?reedJobs.value.length:'err'} → ${deduped.length} unique`);
      return json({ data: deduped, count: deduped.length }, 200, origin);
    }

    // ── Notify: in-app notification + email ───────────────
    if (action === 'notify') {
      const supabaseUrl  = Deno.env.get('SUPABASE_URL') || '';
      const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      const resendKey    = Deno.env.get('RESEND_API_KEY') || '';

      console.log('[notify] Received for user:', body.userId, '| status:', body.newStatus, '| opp:', body.oppTitle);

      // ── 1. Insert in-app notification ──────────────────
      if (supabaseUrl && serviceKey && body.userId) {
        const supa = createClient(supabaseUrl, serviceKey);
        const { error: nErr } = await supa.from('notifications').insert({
          user_id: body.userId,
          title:   body.title   || 'Application update',
          message: body.message || '',
          type:    body.type    || 'info',
          link:    body.link    || null,
          is_read: false,
        });
        if (nErr) {
          console.error('[notify] DB insert FAILED:', nErr.message);
        } else {
          console.log('[notify] In-app notification inserted OK for user:', body.userId);
        }
      } else {
        console.warn('[notify] Skipping DB insert — missing SUPABASE_URL, SERVICE_ROLE_KEY or userId. userId:', body.userId);
      }

      // ── 2. Send email via Resend ────────────────────────
      if (resendKey && body.learnerEmail) {
        console.log('[notify] Sending email to:', body.learnerEmail);

        const statusColor: Record<string,string> = {
          under_review: '#c8a84b', shortlisted: '#0d7a5f',
          interview: '#7c3aed',   approved: '#0d7a5f',
          rejected: '#d95f3b',    placed: '#0d7a5f',
        };
        const color = statusColor[body.newStatus] || '#0d7a5f';

        const emailPayload = {
          from:    'SkillsMatch ZA <onboarding@resend.dev>',
          to:      [body.learnerEmail],
          subject: body.title || 'Application update — SkillsMatch ZA',
          html: `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#f5f2eb;padding:32px;margin:0">
            <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;padding:32px">
              <div style="font-size:20px;font-weight:800;color:#0e1117;margin-bottom:24px;letter-spacing:-0.5px">
                Skills<span style="color:#0d7a5f">Match</span> ZA
              </div>
              <h2 style="color:#0e1117;font-size:18px;margin:0 0 10px">${body.title}</h2>
              <p style="color:#3a3f4b;font-size:14px;line-height:1.7;margin:0 0 20px">${body.message}</p>
              <div style="padding:14px 18px;background:${color}18;border-left:3px solid ${color};border-radius:0 8px 8px 0;font-size:13px;font-weight:600;color:${color};margin-bottom:24px">
                Status: ${(body.newStatus||'').replace(/_/g,' ').replace(/\w/g,(c:string)=>c.toUpperCase())}
              </div>
              <a href="https://skillsmatch.netlify.app/dashboard.html" style="display:inline-block;padding:12px 24px;background:#0d7a5f;color:#ffffff;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500">
                View in dashboard &rarr;
              </a>
              <p style="color:#aaa;font-size:12px;margin-top:28px">
                SkillsMatch ZA &mdash; MICT SETA National Skills Competition
              </p>
            </div>
          </body></html>`,
        };

        const emailRes = await fetch('https://api.resend.com/emails', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resendKey}` },
          body:    JSON.stringify(emailPayload),
        });

        const emailData = await emailRes.json();
        if (emailRes.ok) {
          console.log('[notify] Email sent OK. Resend ID:', emailData.id);
        } else {
          console.error('[notify] Email FAILED:', emailRes.status, JSON.stringify(emailData));
        }
      } else {
        if (!resendKey)         console.warn('[notify] No RESEND_API_KEY set — email skipped.');
        if (!body.learnerEmail) console.warn('[notify] No learnerEmail in body — email skipped.');
      }

      return json({ success: true }, 200, origin);
    }

    // ── AI scoring via Groq ────────────────────────────────
    const groqKey = Deno.env.get('GROQ_API_KEY') || '';
    if (!groqKey) return json({ error: 'GROQ_API_KEY not set. Run: supabase secrets set GROQ_API_KEY=gsk_...' }, 500, origin);

    const gRes  = await fetch(GROQ_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body:    JSON.stringify(toGroq(body)),
    });
    const gData = await gRes.json();
    if (!gRes.ok) return json(gData, gRes.status, origin);

    const text = gData?.choices?.[0]?.message?.content || '';
    return json({ content: [{ type: 'text', text }], model: GROQ_MODEL, role: 'assistant' }, 200, origin);

  } catch (err: any) {
    return json({ error: err.message }, 500, origin);
  }
});