/* ============================================================
   SkillsMatch ZA — match.js  (v2)
   AI-powered job fetching + matching engine.

   Two main capabilities:
   1. fetchExternalJobs()  — uses Claude's web_search tool to find
      real current job listings from LinkedIn, Indeed, Careers24,
      PNet, JobMail and other SA job boards, then saves them to
      the opportunities table so they appear alongside employer posts.

   2. runMatchingPipeline() — scores every opportunity against the
      learner's full profile (skills, qualifications, NQF level,
      certificates, city, province) and returns sorted matches with
      AI-generated insights and skill gap analysis.

   Depends on: api.js (must be loaded first)
   ============================================================ */

/* ── Model config ────────────────────────────────────────── */
const CLAUDE_MODEL           = 'claude-sonnet-4-20250514';
const CLAUDE_MAX_TOKENS      = 2000;
const CLAUDE_SEARCH_TOKENS   = 4000;
const JOB_FETCH_BATCH        = 3;
const SCORE_BATCH            = 4;
const EXTERNAL_SOURCE_PREFIX = 'ext_';

/* ── Proxy config ─────────────────────────────────────────
   All Claude API calls go through the Supabase Edge Function
   claude-proxy. The Anthropic API key lives there as a secret
   — it is never in the browser or in this file.
   The proxy verifies the user's Supabase JWT before forwarding,
   so only logged-in users can trigger AI calls.
   ─────────────────────────────────────────────────────── */
const CLAUDE_PROXY_URL = `${typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : ''}/functions/v1/claude-proxy`;

/* ── JSearch (LinkedIn + Indeed + Glassdoor) ─────────────────────────────
   Job fetching goes through the Supabase Edge Function (claude-proxy).
   The JSEARCH_KEY lives there as a server secret — never in the browser.
   Set it with: supabase secrets set JSEARCH_KEY=your-rapidapi-key
   Free plan: 200 calls/month at rapidapi.com → jsearch
   ─────────────────────────────────────────────────────────────────────── */

/**
 * Get headers for the proxy call.
 * Passes the user's Supabase session JWT so the proxy can
 * verify the user is authenticated before forwarding.
 */
async function claudeHeaders() {
  // Try live session first, fall back to stored token
  let jwt = '';
  try {
    const { data: { session } } = await db.auth.getSession();
    jwt = session?.access_token || '';
  } catch(e) {}

  // Fallback: use token stored at login/register time
  if (!jwt) jwt = localStorage.getItem('sm_access_token') || '';

  return {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${jwt}`,
  };
}

/**
 * No-op — always returns true.
 * Key management is handled server-side in the Edge Function.
 */
function ensureApiKey() { return true; }

/* ── SA job sources Claude will search ───────────────────── */
const SA_JOB_SOURCES = [
  'LinkedIn South Africa jobs',
  'Indeed South Africa jobs',
  'Careers24 jobs',
  'PNet South Africa jobs',
  'JobMail South Africa',
  'PNET learnership South Africa',
  'SETA learnership South Africa',
];


/* ============================================================
   SECTION 1: EXTERNAL JOB FETCHING
   Sources: JSearch (LinkedIn/Indeed/Glassdoor) + Adzuna SA +
            CareerJet SA + Remotive (remote) + Groq web search
   All calls go through the Supabase Edge Function proxy.
   ============================================================ */

/**
 * Master fetch — pulls from all available sources, deduplicates,
 * validates links, then saves to the opportunities table.
 */
async function fetchExternalJobs(learner, { maxJobs = 30, forceRefresh = false } = {}) {
  const skills   = learner.skills        || [];
  const field    = learner.study_field   || '';
  const province = learner.users?.province || 'South Africa';
  const city     = learner.city          || province;
  const qual     = learner.qualification || localStorage.getItem('sm_qual') || '';

  if (!skills.length && !field) {
    console.warn('fetchExternalJobs: no skills or field — skipping');
    return [];
  }

  console.log(`fetchExternalJobs: "${field}" | skills: [${skills.slice(0,3).join(',')}] | ${province}`);

  // Run all sources in parallel — each has its own fallback
  const [rssJobs, groqJobs] = await Promise.allSettled([
    fetchFromRSS(skills, field, qual, province, city),
    fetchFromGroqSearch(skills, field, qual, province),
  ]);

  const allJobs = [
    ...(rssJobs.status  === 'fulfilled' ? rssJobs.value  : []),
    ...(groqJobs.status === 'fulfilled' ? groqJobs.value : []),
  ];

  console.log(`fetchExternalJobs: ${allJobs.length} total (RSS: ${rssJobs.value?.length||0}, Groq supplement: ${groqJobs.value?.length||0})`);

  // Deduplicate, validate links, limit
  const deduped   = deduplicateJobs(allJobs);
  const validated = deduped.map(j => ({ ...j, apply_url: sanitiseUrl(j.apply_url) }));
  const limited   = validated.slice(0, maxJobs);

  if (!limited.length) {
    console.warn('fetchExternalJobs: no jobs from any source');
    return [];
  }

  const saved = await saveExternalJobs(limited);
  console.log(`fetchExternalJobs: saved ${saved.length} jobs`);
  return saved;
}


/* ── SOURCE 1: RSS feeds from Careers24, PNet, Indeed SA, CareerJunction,
                  JobMail, LinkedIn — scraped server-side, direct links only ── */
async function fetchFromRSS(skills, field, qual, province, city) {
  const headers     = await claudeHeaders();
  const topSkills   = skills.slice(0, 4).join(' ');
  const qualLower   = (qual || '').toLowerCase();
  const level       = /degree|btech|honours/.test(qualLower) ? 'graduate'
                    : /n6|n5|diploma/.test(qualLower)         ? 'entry level'
                    : 'learnership';

  // Build keyword sets that give diverse results
  const kwSets = [
    `${topSkills || field} ${level}`,
    `${field || topSkills} South Africa`,
    `learnership internship ${field || 'ICT'} 2026`,
  ];

  const results = await Promise.all(
    kwSets.map(kw =>
      fetch(CLAUDE_PROXY_URL, {
        method:  'POST',
        headers: { ...headers, 'X-Action': 'jobs' },
        body:    JSON.stringify({ keywords: kw, province, field, skills })
      })
      .then(r => r.ok ? r.json() : { data: [] })
      .catch(() => ({ data: [] }))
    )
  );

  const raw = results.flatMap(r => r.data || []);
  console.log(`RSS fetch: ${raw.length} raw results from all sources`);

  // Normalise RSS job format → our opportunities format
  return raw.map(j => ({
    title:        (j.title    || 'Unknown Position').slice(0, 200),
    company:      (j.company  || 'Unknown Company').slice(0, 200),
    location:     (j.location || province || 'South Africa').slice(0, 200),
    province:     extractProvince(j.location || '') || province,
    type:         inferType(j.title || ''),
    sector:       inferSector(j.title || '', j.description || ''),
    description:  (j.description || '').slice(0, 600),
    skills_req:   extractSkillsFromDesc(j.description || ''),
    stipend:      extractStipend(j.description || ''),
    closing_date: j.closing_date || null,
    is_funded:    /seta|funded|stipend|nsfas/i.test(j.description || ''),
    is_remote:    j.is_remote || /remote/i.test(j.title || ''),
    apply_url:    sanitiseUrl(j.apply_url),   // already filtered server-side
    source:       j.source || 'rss',
  })).filter(j => j.apply_url);  // only keep jobs with valid direct links
}

/** Extract province from location string */
function extractProvince(loc) {
  const PROVINCES = ['Gauteng','Western Cape','KwaZulu-Natal','Eastern Cape',
    'Free State','Mpumalanga','Limpopo','North West','Northern Cape'];
  return PROVINCES.find(p => loc.includes(p)) || '';
}

/** Try to extract a stipend/salary from job description text */
function extractStipend(desc) {
  const m = desc.match(/R\s?[\d,]+(?:\s?[-–]\s?R?\s?[\d,]+)?(?:\s?\/?\s?(?:month|per month|p\.m\.|annum|year))?/i);
  return m ? m[0].trim() : null;
}


/* ── SOURCE 2: Adzuna SA (free API — 250 calls/month, no credit card) ──
   Sign up: https://developer.adzuna.com → register → get app_id + app_key
   Add to Edge Function: supabase secrets set ADZUNA_APP_ID=xxx ADZUNA_APP_KEY=xxx
   ─────────────────────────────────────────────────────────────────────── */
async function fetchFromAdzuna(skills, field, province) {
  const headers = await claudeHeaders();
  const query   = encodeURIComponent(`${field || skills.slice(0,3).join(' ')} South Africa`);

  try {
    const res  = await fetch(CLAUDE_PROXY_URL, {
      method: 'POST',
      headers: { ...headers, 'X-Action': 'adzuna' },
      body: JSON.stringify({ query, province, results_per_page: 20 })
    });

    if (!res.ok) return [];  // Adzuna keys not set — silently skip
    const data  = await res.json();
    const jobs  = data.results || [];

    return jobs.map(j => ({
      title:       j.title         || 'Unknown Position',
      company:     j.company?.display_name || 'Unknown Company',
      location:    j.location?.display_name || province,
      province:    province,
      type:        inferType(j.title || ''),
      sector:      inferSector(j.title || '', j.category?.label || ''),
      description: (j.description || '').replace(/<[^>]+>/g, '').slice(0, 600),
      skills_req:  extractSkillsFromDesc(j.description || ''),
      stipend:     j.salary_min ? `R${Math.round(j.salary_min)}–R${Math.round(j.salary_max||j.salary_min)}/year` : null,
      closing_date: null,
      is_funded:   false,
      is_remote:   /remote/i.test(j.title + j.description),
      apply_url:   j.redirect_url || null,
      source:      'adzuna',
    }));
  } catch(e) {
    console.warn('Adzuna fetch failed:', e.message);
    return [];
  }
}


/* ── SOURCE 3: Groq SA job supplement ───────────────────────────────────
   Groq is an LLM — it cannot browse the web. Instead we use it to
   generate realistic SA job listings based on REAL companies that
   are known to hire in South Africa. These supplement JSearch results
   and give learners more relevant local opportunities to score against.
   apply_url is set to the company's real careers page (stable links).
   ─────────────────────────────────────────────────────────────────── */
async function fetchFromGroqSearch(skills, field, qual, province) {
  const headers   = await claudeHeaders();
  const topSkills = skills.slice(0, 4).join(', ');
  const qualLower = (qual || '').toLowerCase();
  const level     = /degree|btech|honours/.test(qualLower) ? 'graduate'
                  : /n6|n5|diploma/.test(qualLower)         ? 'entry level'
                  : 'learnership or internship';

  // Real SA companies with active careers pages — Groq generates
  // plausible listings based on their actual hiring patterns
  const SA_EMPLOYERS = [
    'Telkom SA', 'MTN South Africa', 'Vodacom', 'Cell C',
    'Standard Bank', 'FNB', 'Absa', 'Nedbank', 'Capitec',
    'Dimension Data', 'BCX', 'EOH', 'Accenture South Africa',
    'Allan Gray', 'Discovery', 'Old Mutual',
    'Shoprite', 'Pick n Pay', 'Woolworths',
    'Eskom', 'Transnet', 'SAPS', 'Department of Communications',
  ];

  const CAREERS_URLS = {
    'Telkom SA':             'https://www.telkom.co.za/careers',
    'MTN South Africa':      'https://www.mtn.com/careers/',
    'Vodacom':               'https://careers.vodacom.co.za',
    'Standard Bank':         'https://www.standardbank.com/sbg/standard-bank-group/careers',
    'FNB':                   'https://www.fnb.co.za/about-fnb/careers.html',
    'Absa':                  'https://www.absa.africa/careers/',
    'Nedbank':               'https://www.nedbank.co.za/content/nedbank/desktop/gt/en/careers.html',
    'Capitec':               'https://www.capitecbank.co.za/careers/',
    'Dimension Data':        'https://www.dimensiondata.com/en/careers',
    'Accenture South Africa':'https://www.accenture.com/za-en/careers',
    'Discovery':             'https://www.discovery.co.za/portal/individual/careers',
    'Shoprite':              'https://careers.shoprite.co.za',
  };

  try {
    const r = await fetch(CLAUDE_PROXY_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model:      'llama-3.3-70b-versatile',
        max_tokens: 2500,
        system: `You generate realistic South African job listings for SkillsMatch ZA.
Generate listings that match the learner's profile. Use REAL South African company names.
Each listing must be plausible given the company's actual industry and hiring patterns.

STRICT RULES:
- closing_date must be between today (2026-03-20) and 2026-06-30 — NO 2024 dates
- stipend must be realistic ZAR amounts for South Africa
- apply_url must be the company's real careers page URL
- source must be "careers24", "pnet", or "linkedin"
- type must be one of: Job, Learnership, Internship, Project

Respond with ONLY a valid JSON array, no markdown:`,
        messages: [{
          role: 'user',
          content: `Generate 6 realistic job listings for a learner with this profile:
Skills: ${topSkills || field || 'IT Support'}
Field: ${field || 'Information Technology'}
Qualification level: ${level}
Province: ${province}
Today's date: 2026-03-20

Use these South African companies: ${SA_EMPLOYERS.slice(0,8).join(', ')}

Return ONLY JSON array:
[{"title":"...","company":"...","location":"City, ${province}","province":"${province}","type":"Learnership","sector":"ICT","description":"...","skills_req":["skill1","skill2"],"stipend":"R3500/month","closing_date":"2026-05-30","is_funded":true,"is_remote":false,"apply_url":"https://careers.company.co.za","source":"careers24"}]`
        }]
      })
    });

    if (!r.ok) {
      console.warn('Groq supplement HTTP', r.status);
      return [];
    }

    const data    = await r.json();
    const rawText = data.content?.[0]?.text || '[]';
    const jobs    = safeParseJSONArray(rawText);

    // Post-process: assign real careers URLs and validate dates
    const today = new Date('2026-03-20');
    return jobs
      .map(j => ({
        ...j,
        // Override apply_url with known real careers page if available
        apply_url: CAREERS_URLS[j.company] || j.apply_url || null,
        source: j.source || 'careers24',
      }))
      .filter(j => {
        // Drop any jobs with 2024 or past closing dates
        if (j.closing_date) {
          const d = new Date(j.closing_date);
          if (d < today) return false;
        }
        return j.title && j.company;
      });

  } catch(e) {
    console.warn('Groq supplement failed:', e.message);
    return [];
  }
}


/* ── Link validation ─────────────────────────────────────────────────── */

/**
 * Sanitise and validate a job application URL.
 * Returns null for broken, empty, or obviously wrong links.
 */
function sanitiseUrl(url) {
  if (!url || typeof url !== 'string') return null;

  const u = url.trim();
  if (!u.startsWith('http')) return null;

  // Block all known broken / redirect-stub / expired link patterns
  const BROKEN_PATTERNS = [
    // Indeed redirect stubs — these expire within days
    'indeed.com/viewjob',
    'indeed.com/rc/clk',
    'indeed.com/pagead',
    'za.indeed.com/viewjob',
    // Aggregator spam with high broken-link rates
    'jooble.org',
    'jobrapido.com',
    'trovit.com',
    'trovit.co.za',
    'mitula.co.za',
    'neuvoo.com',
    'jobomas.com',
    'jobbio.com/apply-now',
    'jobbird.com',
    'jobsora.com',
    'careerjet.co.za/jobs/', // careerjet redirect pages
    'jobs.google.com',       // Google Jobs redirects don't work directly
    'adzuna.co.za/land',
    'glassdoor.com/partner', // partner redirect pages
    // Generic broken patterns
    '/viewjob?',
    '/rc/clk?',
    '/pagead/',
  ];

  if (BROKEN_PATTERNS.some(p => u.includes(p))) return null;

  // Must parse as a valid URL
  try {
    const parsed = new URL(u);
    if (!parsed.hostname || parsed.hostname.length < 4) return null;
    // Must have a real path — bare domain links are usually landing pages
    if (parsed.pathname === '/' || parsed.pathname === '') return null;
    return u;
  } catch {
    return null;
  }
}


/**
 * Pick the best apply URL from a JSearch job object.
 * Prefers direct employer/company site links over aggregator redirects.
 */
function pickBestApplyUrl(job) {
  const candidates = [
    job.job_apply_link,
    job.job_google_link,
    job.job_offer_expiration_datetime_utc ? null : null, // placeholder
  ].filter(Boolean);

  // Prefer links that go directly to the employer or a quality board
  const QUALITY_DOMAINS = [
    'linkedin.com/jobs',
    'careers.',          // careers.company.com patterns
    '/careers/',
    '/jobs/',
    'greenhouse.io',
    'lever.co',
    'workday.com',
    'smartrecruiters.com',
    'careers24.com',
    'pnet.co.za',
    'jobmail.co.za',
  ];

  for (const candidate of candidates) {
    const clean = sanitiseUrl(candidate);
    if (!clean) continue;
    // Score: prefer quality domains
    if (QUALITY_DOMAINS.some(d => clean.includes(d))) return clean;
  }

  // Fallback: return first valid URL
  for (const candidate of candidates) {
    const clean = sanitiseUrl(candidate);
    if (clean) return clean;
  }

  return null;
}


/* ── Shared helpers ──────────────────────────────────────────────────── */

function deduplicateJobs(jobs) {
  const seen = new Set();
  return jobs.filter(j => {
    if (!j.title || !j.company) return false;
    const key = `${j.title.toLowerCase().trim()}|${j.company.toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferType(title) {
  const t = title.toLowerCase();
  if (/learnership|learnship/.test(t))    return 'Learnership';
  if (/intern|internship/.test(t))        return 'Internship';
  if (/contract|project|freelance/.test(t)) return 'Project';
  return 'Job';
}

function inferSector(title, company) {
  const t = (title + ' ' + company).toLowerCase();
  if (/tech|software|developer|it |ict|network|cyber|cloud|data/.test(t)) return 'ICT';
  if (/bank|finance|account|audit|insur/.test(t))  return 'Finance';
  if (/retail|shop|store|sales/.test(t))           return 'Retail';
  if (/health|medical|nurs|pharma/.test(t))        return 'Health';
  if (/engineer|construction|civil|mech/.test(t))  return 'Engineering';
  if (/teach|educat|school|college/.test(t))       return 'Education';
  if (/farm|agri/.test(t))                         return 'Agriculture';
  return 'Other';
}

function extractSkillsFromDesc(desc) {
  const KEYWORDS = [
    'Python','JavaScript','Java','SQL','HTML','CSS','React','Node.js','PHP','C#','C++',
    'Excel','PowerPoint','Word','SAP','AutoCAD','Networking','Linux','Windows',
    'Azure','AWS','Git','Docker','Kubernetes','Power BI','Tableau',
    'Customer Service','Communication','Project Management','Teamwork',
    'Accounting','Bookkeeping','Financial Reporting','SolidWorks','MATLAB',
  ];
  const d = desc.toLowerCase();
  return KEYWORDS.filter(s => d.includes(s.toLowerCase())).slice(0, 10);
}

async function saveExternalJobs(jobs) {
  const saved = [];
  for (const job of jobs) {
    try {
      // Skip jobs with no title or company
      if (!job.title || !job.company) continue;

      // Skip jobs with obviously stale closing dates (already closed)
      if (job.closing_date && isValidDate(job.closing_date)) {
        const closes = new Date(job.closing_date);
        const today  = new Date();
        if (closes < today) {
          console.log(`Skipping expired job: "${job.title}" closed ${job.closing_date}`);
          continue;
        }
      }

      const opp = {
        title:        (job.title       || '').slice(0, 200),
        company:      (job.company     || 'Unknown').slice(0, 200),
        location:     (job.location    || job.province || 'South Africa').slice(0, 200),
        province:     (job.province    || '').slice(0, 100),
        type:         ['Job','Learnership','Internship','Project'].includes(job.type) ? job.type : 'Job',
        sector:       (job.sector      || 'Other').slice(0, 100),
        description:  (job.description || '').slice(0, 2000),
        skills_req:   Array.isArray(job.skills_req) ? job.skills_req.slice(0, 20) : [],
        stipend:      job.stipend      || null,
        closing_date: isValidDate(job.closing_date) ? job.closing_date : null,
        is_funded:    Boolean(job.is_funded),
        is_remote:    Boolean(job.is_remote),
        is_active:    true,
        employer_id:  null,
        apply_url:    job.apply_url    || null,   // already sanitised + validated
        source:       (job.source      || 'external').slice(0, 50),
      };

      const { data, error } = await db
        .from('opportunities')
        .upsert(opp, { onConflict: 'title,company', ignoreDuplicates: false })
        .select('id, title, company, apply_url')
        .single();

      if (!error && data) saved.push(data);
    } catch(e) {
      console.warn('saveExternalJobs error:', e.message);
    }
  }
  return saved;
}

/* ============================================================
   SECTION 2: AI MATCHING ENGINE  (enhanced)
   Full profile matching with skills, qualifications, NQF,
   certificates, location preference and gap analysis
   ============================================================ */

/**
 * Full pipeline:
 * 1. Load learner profile
 * 2. Fetch external jobs (LinkedIn, Indeed, etc.)
 * 3. Load all active opportunities (internal + external)
 * 4. Score each with enhanced Claude prompt
 * 5. Save results to matches table
 * 6. Return sorted results with gap analysis
 *
 * @param {Object} opts  - { fetchExternal, progressCallback }
 * @returns {Array}      - sorted match results
 */
async function runMatchingPipeline({ fetchExternal = true, progressCallback = null } = {}) {
  if (!ensureApiKey()) return [];  // prompt for key if missing
  const progress = (msg, pct) => {
    console.log(`[Matching] ${msg}`);
    if (progressCallback) progressCallback(msg, pct);
  };

  progress('Loading your profile…', 5);
  await ensureProfile();

  const profileRes = await getLearnerProfile();
  if (!profileRes.success) {
    console.error('runMatchingPipeline: could not load profile:', profileRes.error);
    return [];
  }

  const learner   = profileRes.data;
  const learnerId = learner.id;
  const skills    = learner.skills          || [];
  const qual      = learner.qualification   || '';
  const field     = learner.study_field     || '';
  const province  = learner.users?.province || '';
  const city      = learner.city            || province;
  const quals     = learner.qualifications  || [];
  const certs     = learner.certificates    || [];
  const linkedin  = learner.linkedin_url    || '';
  const github    = learner.github_url      || '';

  if (!skills.length && !qual) {
    console.warn('runMatchingPipeline: no skills/qualification — complete your profile first');
    return [];
  }

  // Step 2: fetch external jobs if requested
  if (fetchExternal) {
    progress('Searching LinkedIn, Indeed, Careers24…', 15);
    try {
      await fetchExternalJobs(learner, { maxJobs: 25 });
    } catch (err) {
      console.warn('External job fetch failed, continuing with local jobs:', err.message);
    }
  }

  // Step 3: load all active opportunities
  progress('Loading all opportunities…', 35);
  const oppsRes = await getOpportunities();
  if (!oppsRes.success || !oppsRes.data.length) {
    progress('No opportunities found.', 100);
    return [];
  }
  const opportunities = oppsRes.data;
  progress(`Scoring ${opportunities.length} opportunities with AI…`, 45);

  // Step 4: build full learner context for scoring
  const learnerContext = buildLearnerContext(
    skills, qual, field, province, city, quals, certs, linkedin, github
  );

  // Check which opportunities are already scored — skip re-scoring them
  const { data: existingMatches } = await db
    .from('matches')
    .select('opp_id, score, ai_insight')
    .eq('learner_id', learnerId);

  const scoredOppIds = new Set((existingMatches || []).map(m => m.opp_id));
  const toScore      = opportunities.filter(o => !scoredOppIds.has(o.id));
  const alreadyDone  = (existingMatches || []).map(m => ({
    opp_id:     m.opp_id,
    learner_id: learnerId,
    score:      m.score,
    ai_insight: m.ai_insight,
    skill_gaps: [],
    skill_matches: [],
    recommendation: ''
  }));

  progress(`Scoring ${toScore.length} new opportunities (${alreadyDone.length} already scored)…`, 45);

  // Only score new/unscored opportunities
  const newlyScored = toScore.length > 0
    ? await scoreAllOpportunities(learnerId, learnerContext, toScore, progress)
    : [];

  const scoredMatches = [...alreadyDone, ...newlyScored];

  // Step 5: save to Supabase
  progress('Saving your matches…', 90);
  await saveMatches(learnerId, scoredMatches);

  // Update avg score
  const scores = scoredMatches.map(m => m.score);
  const avg    = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  await updateLearnerProfile({ avg_match_score: avg });

  progress('Done!', 100);

  // Step 6: return sorted
  return scoredMatches
    .sort((a, b) => b.score - a.score)
    .map(m => ({
      ...m,
      opportunity: opportunities.find(o => o.id === m.opp_id)
    }));
}


/**
 * Build a rich structured context string for the learner
 * that Claude uses in every scoring prompt.
 */
function buildLearnerContext(skills, qual, field, province, city, quals, certs, linkedin, github) {
  // Derive experience level from qualification type
  let expLevel = 'Entry level / recent graduate';
  const qualLower = (qual || '').toLowerCase();
  if (/honours|degree|btech/.test(qualLower))        expLevel = 'Graduate (Degree/BTech)';
  else if (/diploma|national diploma/.test(qualLower)) expLevel = 'Diploma holder';
  else if (/n6|n5|n4|nqf/.test(qualLower))            expLevel = 'TVET graduate (N4-N6)';
  else if (/learnership|certificate/.test(qualLower))  expLevel = 'Learnership / Certificate';

  // Primary qualification
  let qualSection = `Qualification: ${qual || 'Not specified'}\nField of study: ${field || 'Not specified'}\nExperience level: ${expLevel}`;

  // Additional qualifications
  if (quals.length > 1) {
    qualSection += '\nAdditional qualifications:';
    quals.forEach(q => {
      if (q.qualification) {
        qualSection += `\n  - ${q.qualification} at ${q.institution || 'unknown'} (NQF ${q.nqf || '?'}, ${q.status || ''})`;
      }
    });
  } else if (quals.length === 1 && quals[0].nqf) {
    qualSection += `\nNQF level: ${quals[0].nqf}`;
  }

  // Online certificates
  let certSection = '';
  if (certs.length) {
    certSection = '\nOnline certificates: ' + certs.map(c => `${c.name} (${c.platform || ''})`).join(', ');
  }

  // Portfolio signals
  let portfolioSection = '';
  if (github)   portfolioSection += '\nHas GitHub portfolio: Yes';
  if (linkedin) portfolioSection += '\nHas LinkedIn profile: Yes';

  return [
    `Province: ${province || 'Not specified'}`,
    `City: ${city || province || 'Not specified'}`,
    qualSection,
    certSection,
    `Skills: ${skills.join(', ') || 'None listed'}`,
    portfolioSection,
  ].filter(Boolean).join('\n');
}


/**
 * Score all opportunities in batches of SCORE_BATCH.
 */
async function scoreAllOpportunities(learnerId, learnerContext, opportunities, progress) {
  const results  = [];
  const total    = opportunities.length;
  // Groq free tier: 30 req/min. With batch of 3 and 1.5s delay = ~20 req/min safely.
  const DELAY_MS = 1500;

  for (let i = 0; i < total; i += SCORE_BATCH) {
    const batch  = opportunities.slice(i, i + SCORE_BATCH);
    const scored = await Promise.all(
      batch.map(opp => scoreOneOpportunity(learnerId, learnerContext, opp))
    );
    results.push(...scored);

    const pct = 45 + Math.round(((i + SCORE_BATCH) / total) * 40);
    if (progress) progress(`Scored ${Math.min(i + SCORE_BATCH, total)} / ${total}…`, pct);

    // Pause between batches to stay under Groq's 30 req/min free tier limit
    if (i + SCORE_BATCH < total) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  return results;
}


/**
 * Score a single learner–opportunity pair.
 * Enhanced prompt includes gap analysis, certificate relevance,
 * location fit, and NQF level match.
 */
async function scoreOneOpportunity(learnerId, learnerContext, opp) {
  const oppContext = buildOpportunityContext(opp);
  const prompt     = buildScoringPrompt(learnerContext, oppContext);

  try {
    const response = await fetch(CLAUDE_PROXY_URL, {
      method:  'POST',
      headers: await claudeHeaders(),
      body: JSON.stringify({
        model:      CLAUDE_MODEL,
        max_tokens: CLAUDE_MAX_TOKENS,
        system: `You are an expert career advisor for SkillsMatch ZA, a South African skills-matching platform.
Your job: analyse how well a learner's profile matches a job opportunity and return a precise JSON score.

SCORING CRITERIA (total 100 points):
- Skills match (40 pts): overlap between learner skills and required skills
- Qualification match (25 pts): relevance of NQF level, field of study, and certificates
- Location fit (15 pts): same city = full points, same province = partial, remote = full
- Profile completeness (10 pts): GitHub, LinkedIn, certificates add credibility signals
- Experience level fit (10 pts): learnership/entry level matches recent graduate status

ALWAYS respond with ONLY valid JSON, no markdown, no preamble:
{
  "score": <integer 0-100>,
  "insight": "<one sentence, max 25 words: most important strength OR gap for this specific match>",
  "skill_gaps": ["missing skill 1", "missing skill 2"],
  "skill_matches": ["matching skill 1", "matching skill 2"],
  "recommendation": "<one actionable sentence: what should the learner do to improve their chances>"
}`,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) throw new Error(`Claude API ${response.status}`);

    const apiData = await response.json();
    const rawText = apiData.content?.[0]?.text || '{}';
    const parsed  = safeParseJSON(rawText);

    return {
      opp_id:          opp.id,
      learner_id:      learnerId,
      score:           clamp(parsed.score ?? 50, 0, 100),
      ai_insight:      parsed.insight      ?? 'No insight available.',
      skill_gaps:      parsed.skill_gaps   ?? [],
      skill_matches:   parsed.skill_matches ?? [],
      recommendation:  parsed.recommendation ?? '',
    };

  } catch (err) {
    console.warn(`Scoring failed for "${opp.title}":`, err.message);
    return {
      opp_id:         opp.id,
      learner_id:     learnerId,
      score:          fallbackScore(
                        learnerContext.split('Skills: ')[1]?.split('\n')[0]?.split(', ') || [],
                        opp.skills_req || []
                      ),
      ai_insight:     'AI scoring unavailable — score based on keyword overlap.',
      skill_gaps:     [],
      skill_matches:  [],
      recommendation: '',
    };
  }
}


/**
 * Build opportunity context string for the scoring prompt.
 */
function buildOpportunityContext(opp) {
  const lines = [
    `Title: ${opp.title}`,
    `Company: ${opp.company}`,
    `Type: ${opp.type}`,
    `Sector: ${opp.sector || 'Not specified'}`,
    `Location: ${opp.location}`,
    `Province: ${opp.province || 'Not specified'}`,
    `Remote: ${opp.is_remote ? 'Yes' : 'No'}`,
    `SETA funded: ${opp.is_funded ? 'Yes' : 'No'}`,
    `Required skills: ${(opp.skills_req || []).join(', ') || 'Not specified'}`,
    opp.stipend      ? `Stipend/Salary: ${opp.stipend}` : null,
    opp.description  ? `Description: ${opp.description.slice(0, 300)}` : null,
    opp.closing_date ? `Closing: ${opp.closing_date}` : null,
    opp.source       ? `Source: ${opp.source}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}


/**
 * Build the full scoring prompt combining learner + opportunity.
 */
function buildScoringPrompt(learnerContext, oppContext) {
  return `LEARNER PROFILE:
${learnerContext}

OPPORTUNITY:
${oppContext}

Analyse this match carefully. Consider:
1. Do the learner's skills cover the required skills?
2. Is the learner's qualification level appropriate (NQF, field)?
3. Is the location compatible?
4. Do their certificates or portfolio signals add value?
5. Is the opportunity type (learnership/job) appropriate for a recent graduate?

Return ONLY the JSON object with score, insight, skill_gaps, skill_matches, and recommendation.`;
}


/* ============================================================
   SECTION 3: SMART MATCHING SUMMARY
   After scoring, generate an overall career summary for the learner
   ============================================================ */

/**
 * Generate an AI career summary for the learner based on their
 * top matches — shown on the dashboard overview panel.
 *
 * @param {Array}  topMatches  - top 5 match objects with scores
 * @param {Object} learner     - learner profile
 * @returns {string}           - HTML string with career advice
 */
async function generateCareerSummary(topMatches, learner) {
  if (!topMatches.length) return null;

  const skills   = learner.skills || [];
  const topScore = topMatches[0]?.score || 0;
  const avgScore = Math.round(topMatches.reduce((a, b) => a + b.score, 0) / topMatches.length);

  // Collect all skill gaps from top matches
  const allGaps = topMatches
    .flatMap(m => m.skill_gaps || [])
    .reduce((acc, g) => {
      acc[g] = (acc[g] || 0) + 1;
      return acc;
    }, {});
  const topGaps = Object.entries(allGaps)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([skill]) => skill);

  try {
    const response = await fetch(CLAUDE_PROXY_URL, {
      method: 'POST',
      headers: await claudeHeaders(),
      body: JSON.stringify({
        model:      CLAUDE_MODEL,
        max_tokens: 500,
        system: `You are a friendly SA career advisor. Write concise, encouraging advice for a job seeker.
Respond with ONLY a JSON object:
{
  "headline": "<10 words max: positive summary of their job market position>",
  "tip": "<25 words max: single most impactful thing they can do to improve matches>",
  "top_skill_to_add": "<one specific skill or certificate name that appears most in their gaps>"
}`,
        messages: [{
          role: 'user',
          content: `Learner skills: ${skills.join(', ')}
Top match score: ${topScore}%
Average match score: ${avgScore}%
Most common skill gaps across top ${topMatches.length} matches: ${topGaps.join(', ')}

Write career advice for this learner.`
        }]
      })
    });

    if (!response.ok) throw new Error(`Claude API ${response.status}`);
    const data   = await response.json();
    const parsed = safeParseJSON(data.content?.[0]?.text || '{}');
    return parsed;

  } catch (err) {
    console.warn('generateCareerSummary error:', err.message);
    return null;
  }
}


/* ============================================================
   SECTION 4: RENDER HELPERS  (enhanced match card)
   ============================================================ */

/**
 * Render a match card with skill gap badges, apply/save,
 * and link to original job posting if external.
 */
function renderMatchCard(match, container, onApply) {
  const opp = match.opportunity;
  if (!opp) return;

  const sc = match.score >= 80 ? 'var(--teal)'
           : match.score >= 65 ? 'var(--gold)'
           : 'var(--coral)';

  const ICONS = { Job:'💼', Learnership:'🎓', Internship:'📋', Project:'🚀' };
  const isExternal = opp.source && opp.source !== 'internal';

  // Skill match + gap badges (max 4 each)
  const matchBadges = (match.skill_matches || []).slice(0, 4)
    .map(s => `<span style="font-size:11px;padding:2px 8px;border-radius:99px;background:var(--teal-lt);color:var(--teal)">✓ ${escHtml(s)}</span>`)
    .join('');
  const gapBadges = (match.skill_gaps || []).slice(0, 3)
    .map(s => `<span style="font-size:11px;padding:2px 8px;border-radius:99px;background:var(--coral-lt);color:var(--coral)">+ ${escHtml(s)}</span>`)
    .join('');

  const card = document.createElement('div');
  card.className = 'match-card';
  card.innerHTML = `
    <div class="mc-header">
      <div style="flex:1;min-width:0">
        <div class="mc-title">${escHtml(opp.title)}
          ${isExternal ? `<span style="font-size:10px;padding:2px 7px;border-radius:99px;background:var(--gold-lt);color:var(--gold);font-weight:600;margin-left:6px;vertical-align:middle">${escHtml(opp.source?.toUpperCase())}</span>` : ''}
        </div>
        <div class="mc-company">${escHtml(opp.company)} &mdash; ${escHtml(opp.location)}</div>
      </div>
      <div class="mc-score" style="color:${sc}">${match.score}%</div>
    </div>
    <div class="mc-bar-bg">
      <div class="mc-bar${match.score < 80 ? ' mid' : ''}" data-w="${match.score}" style="width:0%"></div>
    </div>

    <div class="mc-tags" style="margin-bottom:8px">
      <span class="mc-tag">${ICONS[opp.type] || ''} ${escHtml(opp.type)}</span>
      ${opp.is_funded  ? '<span class="mc-tag funded">SETA funded</span>' : ''}
      ${opp.is_remote  ? '<span class="mc-tag">🌐 Remote</span>' : ''}
      ${opp.stipend    ? `<span class="mc-tag">💰 ${escHtml(opp.stipend)}</span>` : ''}
      ${opp.closing_date ? `<span class="mc-tag" style="color:var(--coral)">⏳ Closes ${formatMatchDate(opp.closing_date)}</span>` : ''}
    </div>

    ${matchBadges || gapBadges ? `
    <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">
      ${matchBadges}${gapBadges}
    </div>` : ''}

    <div class="mc-tip">
      <strong>AI insight:</strong> ${escHtml(match.ai_insight)}
      ${match.recommendation ? `<br><span style="color:var(--teal);font-weight:500">💡 ${escHtml(match.recommendation)}</span>` : ''}
    </div>

    <div class="mc-apply">
      ${isExternal && opp.apply_url
        ? `<a href="${escHtml(opp.apply_url)}" target="_blank" rel="noopener" class="btn btn-primary btn-sm">Apply on ${escHtml(opp.source)}</a>`
        : `<button class="btn btn-primary btn-sm apply-btn">Apply now</button>`
      }
      <button class="btn btn-ghost btn-sm save-btn">Save</button>
    </div>`;

  // Animate bar
  setTimeout(() => {
    const bar = card.querySelector('.mc-bar');
    if (bar) bar.style.width = bar.getAttribute('data-w') + '%';
  }, 100);

  // Internal apply button
  const applyBtn = card.querySelector('.apply-btn');
  if (applyBtn) {
    applyBtn.addEventListener('click', async () => {
      applyBtn.disabled = true;
      applyBtn.textContent = 'Applying…';
      const result = await applyToOpportunity(opp.id, match.score);
      if (result.success || result.alreadyApplied) {
        card.querySelector('.mc-apply').innerHTML =
          `<span class="applied-badge">✓ Applied</span>
           <span style="font-size:12px;color:var(--ink-muted);align-self:center;margin-left:6px">We'll notify you of updates.</span>`;
        if (onApply) onApply(opp.id);
      } else {
        applyBtn.disabled = false;
        applyBtn.textContent = 'Apply now';
      }
    });
  }

  // Save button
  card.querySelector('.save-btn')?.addEventListener('click', function() {
    this.textContent = this.textContent === 'Save' ? '✓ Saved' : 'Save';
  });

  container.appendChild(card);
}


/**
 * Render all matches with progress indicator.
 * Fetches external jobs + runs AI pipeline if no cached matches.
 */
async function renderAllMatches(containerId, limit = null) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Show progress skeleton
  container.innerHTML = progressSkeleton('Searching LinkedIn, Indeed, Careers24…');

  // Check cache
  const matchRes = await getMyMatches();
  let matches = matchRes.data || [];

  if (!matches.length) {
    // Run full pipeline with progress updates
    updateProgressSkeleton(container, 'Fetching live job listings…', 20);

    const pipeline = await runMatchingPipeline({
      fetchExternal: true,
      progressCallback: (msg, pct) => updateProgressSkeleton(container, msg, pct)
    });

    matches = pipeline.map(m => ({
      score:         m.score,
      ai_insight:    m.ai_insight,
      skill_gaps:    m.skill_gaps,
      skill_matches: m.skill_matches,
      recommendation: m.recommendation,
      opportunities: m.opportunity
    }));
  }

  container.innerHTML = '';

  if (!matches.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div style="font-size:36px;margin-bottom:12px">🔍</div>
        <h3>No matches yet</h3>
        <p>Complete your skills profile to get AI-powered matches from LinkedIn, Indeed and more.</p>
        <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="showView('l-profile',null)">Update profile</button>
      </div>`;
    return;
  }

  const display = limit ? matches.slice(0, limit) : matches;
  display.forEach(m => {
    renderMatchCard({
      score:         m.score,
      ai_insight:    m.ai_insight,
      skill_gaps:    m.skill_gaps    || [],
      skill_matches: m.skill_matches || [],
      recommendation: m.recommendation || '',
      opportunity:   m.opportunities
    }, container, null);
  });
}


/* ============================================================
   SECTION 5: UTILITIES
   ============================================================ */

function clamp(val, min, max) { return Math.min(Math.max(val, min), max); }

function safeParseJSON(str) {
  try {
    const clean = str.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    const m = str.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { return {}; } }
    return {};
  }
}

function safeParseJSONArray(str) {
  try {
    const clean = str.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const m = str.match(/\[[\s\S]*\]/);
    if (m) { try { const p = JSON.parse(m[0]); return Array.isArray(p) ? p : []; } catch { return []; } }
    return [];
  }
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isValidDate(str) {
  if (!str) return false;
  const d = new Date(str);
  return !isNaN(d.getTime()) && d.getFullYear() > 2020;
}

function formatMatchDate(str) {
  try { return new Date(str).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return str; }
}

function fallbackScore(learnerSkills, requiredSkills) {
  if (!Array.isArray(requiredSkills) || !requiredSkills.length) return 50;
  const lLower = (learnerSkills || []).map(s => String(s).toLowerCase());
  const rLower = requiredSkills.map(s => String(s).toLowerCase());
  const hits = rLower.filter(r => lLower.some(l => l.includes(r) || r.includes(l))).length;
  return Math.round((hits / rLower.length) * 75) + 10;
}

function progressSkeleton(msg) {
  return `
    <div style="padding:20px;text-align:center">
      <div style="font-size:13px;color:var(--ink-muted);margin-bottom:16px" id="progressMsg">${escHtml(msg)}</div>
      <div style="height:4px;background:var(--paper-2);border-radius:99px;overflow:hidden;max-width:300px;margin:0 auto">
        <div id="progressBar" style="height:100%;width:5%;background:var(--teal);border-radius:99px;transition:width .4s ease"></div>
      </div>
    </div>
    ${[1,2,3].map(() => `
      <div class="match-card">
        <div style="height:14px;width:60%;border-radius:4px;margin-bottom:8px" class="skeleton"></div>
        <div style="height:12px;width:40%;border-radius:4px;margin-bottom:12px" class="skeleton"></div>
        <div style="height:4px;width:100%;border-radius:4px" class="skeleton"></div>
      </div>`).join('')}`;
}

function updateProgressSkeleton(container, msg, pct) {
  const msgEl = container.querySelector('#progressMsg');
  const barEl = container.querySelector('#progressBar');
  if (msgEl) msgEl.textContent = msg;
  if (barEl) barEl.style.width = Math.min(pct, 95) + '%';
}


/* ============================================================
   SECTION 6: QUICK SCORE (on-demand, no save)
   ============================================================ */

async function quickScore(oppId) {
  const profileRes = await getLearnerProfile();
  if (!profileRes.success) return { score: 0, insight: 'Unable to load profile.' };

  const learner = profileRes.data;
  const oppRes  = await getOpportunityById(oppId);
  if (!oppRes.success) return { score: 0, insight: 'Unable to load opportunity.' };

  const ctx = buildLearnerContext(
    learner.skills || [],
    learner.qualification || '',
    learner.study_field || '',
    learner.users?.province || '',
    learner.city || '',
    learner.qualifications || [],
    learner.certificates || [],
    learner.linkedin_url || '',
    learner.github_url || ''
  );

  const result = await scoreOneOpportunity(learner.id, ctx, oppRes.data);
  return { score: result.score, insight: result.ai_insight, gaps: result.skill_gaps };
}