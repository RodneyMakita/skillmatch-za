/* ============================================================
   SkillsMatch ZA — match.js
   AI-powered matching engine.
   Uses Claude API to score learner skills vs opportunity
   requirements, then saves results to Supabase via api.js.

   Depends on: api.js (must be loaded first)
   ============================================================ */

/* ── Claude API config ───────────────────────────────────── */
const CLAUDE_MODEL      = 'claude-sonnet-4-20250514';
const CLAUDE_MAX_TOKENS = 800;

/* ── Main: run matching for logged-in learner ────────────── */

/**
 * Run full AI matching pipeline for the current learner.
 * 1. Fetch learner skills from Supabase
 * 2. Fetch all active opportunities
 * 3. Score each one via Claude API
 * 4. Save results back to Supabase matches table
 * 5. Return sorted match objects for rendering
 *
 * @returns {Array} Sorted match results with score + ai_insight
 */
async function runMatchingPipeline() {
  /* 1. Make sure profile IDs are resolved */
  await ensureProfile();

  /* 1b. Get learner profile */
  const profileRes = await getLearnerProfile();
  if (!profileRes.success) {
    console.error('Could not load learner profile:', profileRes.error);
    return [];
  }

  const learner    = profileRes.data;
  const learnerId  = learner.id;
  const skills     = learner.skills || [];
  const qual       = learner.qualification || '';
  const field      = learner.study_field   || '';
  const province   = learner.users?.province || '';

  if (!skills.length) {
    console.warn('Learner has no skills — skipping matching.');
    return [];
  }

  /* 2. Fetch active opportunities */
  const oppsRes = await getOpportunities();
  if (!oppsRes.success || !oppsRes.data.length) return [];

  const opportunities = oppsRes.data;

  /* 3. Score each opportunity */
  const scoredMatches = await scoreOpportunities(learnerId, skills, qual, field, province, opportunities);

  /* 4. Save to Supabase */
  await saveMatches(learnerId, scoredMatches);

  /* 5. Update learner avg score */
  const scores = scoredMatches.map(m => m.score);
  const avg    = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0) / scores.length) : 0;
  await updateLearnerProfile({ avg_match_score: avg });

  /* 6. Return sorted by score */
  return scoredMatches
    .sort((a, b) => b.score - a.score)
    .map(m => ({
      ...m,
      opportunity: opportunities.find(o => o.id === m.opp_id)
    }));
}


/**
 * Score a batch of opportunities for one learner using Claude.
 * Batches to avoid too many sequential API calls.
 */
async function scoreOpportunities(learnerId, skills, qual, field, province, opportunities) {
  const results = [];

  /* Process in batches of 3 to avoid rate limits */
  const BATCH = 3;
  for (let i = 0; i < opportunities.length; i += BATCH) {
    const batch   = opportunities.slice(i, i + BATCH);
    const scored  = await Promise.all(
      batch.map(opp => scoreOne(learnerId, skills, qual, field, province, opp))
    );
    results.push(...scored);
  }

  return results;
}


/**
 * Score a single learner–opportunity pair using Claude API.
 */
async function scoreOne(learnerId, skills, qual, field, province, opp) {
  const prompt = buildPrompt(skills, qual, field, province, opp);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:      CLAUDE_MODEL,
        max_tokens: CLAUDE_MAX_TOKENS,
        system: `You are an AI career advisor for SkillsMatch ZA, a South African skills-to-opportunity platform.
Your job is to score how well a learner's profile matches a job opportunity.

ALWAYS respond with ONLY a valid JSON object in this exact format — no markdown, no explanation, no extra text:
{
  "score": <integer 0-100>,
  "insight": "<one sentence explaining the match and the single most important skill gap or strength, max 20 words>"
}`,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) throw new Error(`Claude API ${response.status}`);

    const apiData   = await response.json();
    const rawText   = apiData.content?.[0]?.text || '{}';
    const parsed    = safeParseJSON(rawText);

    return {
      opp_id:     opp.id,
      learner_id: learnerId,
      score:      clamp(parsed.score ?? 50, 0, 100),
      ai_insight: parsed.insight ?? 'No insight available.'
    };

  } catch (err) {
    console.warn(`Scoring failed for "${opp.title}":`, err.message);
    /* Fallback: simple keyword overlap score */
    return {
      opp_id:     opp.id,
      learner_id: learnerId,
      score:      fallbackScore(skills, opp.skills_req || []),
      ai_insight: 'AI scoring unavailable — score based on keyword overlap.'
    };
  }
}


/**
 * Build the matching prompt for Claude
 */
function buildPrompt(skills, qual, field, province, opp) {
  return `LEARNER PROFILE:
- Qualification: ${qual || 'Not specified'}
- Field of study: ${field || 'Not specified'}
- Province: ${province || 'Not specified'}
- Skills: ${skills.join(', ') || 'None listed'}

OPPORTUNITY:
- Title: ${opp.title}
- Company: ${opp.company}
- Type: ${opp.type}
- Sector: ${opp.sector}
- Location: ${opp.location}
- Required skills: ${(opp.skills_req || []).join(', ') || 'Not specified'}

Score this match from 0 to 100. Consider: skill overlap, qualification relevance, location compatibility.
Respond with ONLY the JSON object.`;
}


/**
 * Fallback scoring when Claude API is unavailable.
 * Uses simple keyword overlap between learner skills and required skills.
 */
function fallbackScore(learnerSkills, requiredSkills) {
  if (!requiredSkills.length) return 50;

  const lowerLearner  = learnerSkills.map(s => s.toLowerCase());
  const lowerRequired = requiredSkills.map(s => s.toLowerCase());

  const matches = lowerRequired.filter(req =>
    lowerLearner.some(skill =>
      skill.includes(req) || req.includes(skill)
    )
  ).length;

  return Math.round((matches / lowerRequired.length) * 80) + 10; /* 10–90 range */
}


/* ── Render helpers ──────────────────────────────────────── */

/**
 * Render a match card into a container element.
 * Call this from dashboard.html and matches view.
 *
 * @param {Object} match  - { score, ai_insight, opportunity }
 * @param {Element} container - DOM element to append into
 * @param {Function} onApply - callback when Apply is clicked
 */
function renderMatchCard(match, container, onApply) {
  const opp   = match.opportunity;
  if (!opp) return;

  const scoreColor = match.score >= 80
    ? 'var(--teal)'
    : match.score >= 65
    ? 'var(--gold)'
    : 'var(--ink-muted)';

  const typeIcons = { Job:'💼', Learnership:'🎓', Internship:'📋', Project:'🚀' };

  const card = document.createElement('div');
  card.className = 'match-card';
  card.innerHTML = `
    <div class="mc-header">
      <div>
        <div class="mc-title">${escHtml(opp.title)}</div>
        <div class="mc-company">${escHtml(opp.company)} &mdash; ${escHtml(opp.location)}</div>
      </div>
      <div class="mc-score" style="color:${scoreColor}">${match.score}%</div>
    </div>
    <div class="mc-bar-bg">
      <div class="mc-bar${match.score < 80 ? ' mid' : ''}" data-w="${match.score}"></div>
    </div>
    <div class="mc-tags">
      <span class="mc-tag">${typeIcons[opp.type] || ''} ${escHtml(opp.type)}</span>
      ${opp.is_funded ? '<span class="mc-tag funded">SETA funded</span>' : ''}
      ${opp.is_remote ? '<span class="mc-tag">Remote</span>' : ''}
      ${opp.is_urgent ? '<span class="mc-tag" style="background:var(--coral-lt);color:var(--coral)">Closing soon</span>' : ''}
    </div>
    <div class="mc-tip">
      <strong>AI insight:</strong> ${escHtml(match.ai_insight)}
    </div>
    <div class="mc-apply">
      <button class="btn btn-primary btn-sm apply-btn">Apply now</button>
      <button class="btn btn-ghost btn-sm">Save</button>
    </div>`;

  /* Animate score bar after insertion */
  setTimeout(() => {
    const bar = card.querySelector('.mc-bar');
    if (bar) bar.style.width = bar.getAttribute('data-w') + '%';
  }, 100);

  /* Apply button handler */
  card.querySelector('.apply-btn').addEventListener('click', async () => {
    const result = await applyToOpportunity(opp.id, match.score);
    if (result.success) {
      card.querySelector('.mc-apply').innerHTML =
        `<span class="applied-badge">✓ Applied</span>
         <span style="font-size:12px;color:var(--ink-muted);align-self:center;margin-left:6px">We'll notify you of updates.</span>`;
      if (onApply) onApply(opp.id);
    }
  });

  container.appendChild(card);
}

/**
 * Render all matches into a container.
 * Shows loading skeleton while fetching.
 */
async function renderAllMatches(containerId, limit = null) {
  const container = document.getElementById(containerId);
  if (!container) return;

  /* Show skeleton */
  container.innerHTML = `
    ${[1,2,3].map(() => `
      <div class="match-card">
        <div style="height:14px;width:60%;border-radius:4px" class="skeleton"></div>
        <div style="height:12px;width:40%;border-radius:4px;margin-top:8px" class="skeleton"></div>
        <div style="height:4px;width:100%;border-radius:4px;margin-top:12px" class="skeleton"></div>
      </div>`).join('')}`;

  /* Check for cached matches first */
  const matchRes = await getMyMatches();
  let matches = matchRes.data || [];

  /* If no matches cached, run the pipeline */
  if (!matches.length) {
    const pipeline = await runMatchingPipeline();
    matches = pipeline.map(m => ({
      score:      m.score,
      ai_insight: m.ai_insight,
      is_saved:   false,
      opportunities: m.opportunity
    }));
  }

  container.innerHTML = '';

  if (!matches.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <h3>No matches yet</h3>
        <p>Complete your skills profile to get AI-powered matches.</p>
        <a href="dashboard.html" class="btn btn-primary btn-sm" style="margin-top:12px">Update profile</a>
      </div>`;
    return;
  }

  const display = limit ? matches.slice(0, limit) : matches;
  display.forEach(m => {
    const match = {
      score:      m.score,
      ai_insight: m.ai_insight,
      opportunity: m.opportunities /* Supabase join name */
    };
    renderMatchCard(match, container, null);
  });
}


/* ── Utility helpers ─────────────────────────────────────── */

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

function safeParseJSON(str) {
  try {
    /* Strip potential markdown fences */
    const clean = str.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    /* Try extracting first JSON object */
    const match = str.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { return {}; }
    }
    return {};
  }
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


/* ── Quick single-card score (for detail modal) ──────────── */

/**
 * Score one opportunity on-demand (e.g. when opening a modal)
 * Returns { score, insight } without saving to DB
 */
async function quickScore(oppId) {
  const profileRes = await getLearnerProfile();
  if (!profileRes.success) return { score: 0, insight: 'Unable to load profile.' };

  const learner = profileRes.data;
  const oppRes  = await getOpportunityById(oppId);
  if (!oppRes.success) return { score: 0, insight: 'Unable to load opportunity.' };

  const result = await scoreOne(
    learner.id,
    learner.skills || [],
    learner.qualification || '',
    learner.study_field   || '',
    learner.users?.province || '',
    oppRes.data
  );

  return { score: result.score, insight: result.ai_insight };
}