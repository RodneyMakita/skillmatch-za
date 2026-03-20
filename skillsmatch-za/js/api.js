/* ============================================================
   SkillsMatch ZA — api.js
   Supabase client + all data functions used by every page.

   SETUP:
   1. Go to https://app.supabase.com → your project → Settings → API
   2. Copy your Project URL and anon/public key
   3. Replace the two values below
   4. Add this to every HTML page BEFORE your page scripts:
      <script src="js/api.js"></script>
   ============================================================ */

/* ── Supabase config ─────────────────────────────────────── */
const SUPABASE_URL  = 'https://xykfvlyidatykliocqam.supabase.co';   // ← replace
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5a2Z2bHlpZGF0eWtsaW9jcWFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTIxMDcsImV4cCI6MjA4OTU4ODEwN30.QVWRWctF5y26pHBzjhWHpjJ2N2cmAuiYmgyPDIjFb3g';                  // ← replace

/* ── Load Supabase client from CDN ───────────────────────── */
/* Add this script tag BEFORE api.js in your HTML:
   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
*/
const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON);

/* ── Auth helpers ────────────────────────────────────────── */

/**
 * Register a new user (learner, employer, or admin)
 * Called from register.html on submit
 */
async function registerUser({ email, password, role, firstName, lastName, province, phone }) {
  try {
    /* 1. Create auth account */
    const { data: authData, error: authErr } = await db.auth.signUp({ email, password });
    if (authErr) throw authErr;

    /* 2. Insert into public.users */
    const { data: userData, error: userErr } = await db
      .from('users')
      .insert({
        auth_id:    authData.user.id,
        role,
        email,
        first_name: firstName,
        last_name:  lastName,
        province,
        phone
      })
      .select()
      .single();

    if (userErr) throw userErr;

    /* 3. Save to localStorage for immediate use */
    localStorage.setItem('sm_auth',  'true');
    localStorage.setItem('sm_role',  role);
    localStorage.setItem('sm_email', email);
    localStorage.setItem('sm_name',  `${firstName} ${lastName}`);
    localStorage.setItem('sm_uid',   userData.id);

    return { success: true, user: userData };
  } catch (err) {
    console.error('registerUser error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Log in an existing user
 * Called from login.html on submit
 */
async function loginUser({ email, password }) {
  try {
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) throw error;

    /* Fetch profile from public.users */
    const { data: profile, error: profErr } = await db
      .from('users')
      .select('*')
      .eq('auth_id', data.user.id)
      .single();

    if (profErr) throw profErr;

    localStorage.setItem('sm_auth',  'true');
    localStorage.setItem('sm_role',  profile.role);
    localStorage.setItem('sm_email', profile.email);
    localStorage.setItem('sm_name',  `${profile.first_name} ${profile.last_name}`);
    localStorage.setItem('sm_uid',   profile.id);

    return { success: true, profile };
  } catch (err) {
    console.error('loginUser error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Log out current user
 */
async function logoutUser() {
  await db.auth.signOut();
  ['sm_auth','sm_role','sm_email','sm_name','sm_uid','sm_learner_id','sm_skills'].forEach(k => {
    localStorage.removeItem(k);
  });
  window.location.href = 'login.html';
}

/**
 * Get the current Supabase auth session
 */
async function getSession() {
  const { data: { session } } = await db.auth.getSession();
  return session;
}


/* ── Opportunities ───────────────────────────────────────── */

/**
 * Fetch all active opportunities with optional filters
 * @param {Object} filters - { type, province, sector, search }
 * @param {string} sortBy  - 'newest' | 'closing' (default: return as-is, match scoring in match.js)
 */
async function getOpportunities({ type, province, sector, search } = {}, sortBy = 'newest') {
  try {
    let query = db
      .from('opportunities')
      .select('*')
      .eq('is_active', true);

    if (type     && type     !== 'all') query = query.eq('type', type);
    if (province && province !== 'all') {
      /* Handle "Remote" filter separately */
      if (province === 'Remote') {
        query = query.eq('is_remote', true);
      } else {
        query = query.ilike('location', `%${province}%`);
      }
    }
    if (sector   && sector   !== 'all') query = query.ilike('sector', `%${sector}%`);
    if (search)                          query = query.or(`title.ilike.%${search}%,company.ilike.%${search}%`);

    if (sortBy === 'newest')  query = query.order('created_at', { ascending: false });
    if (sortBy === 'closing') query = query.order('closing_date', { ascending: true });

    const { data, error } = await query;
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    console.error('getOpportunities error:', err);
    return { success: false, data: [], error: err.message };
  }
}

/**
 * Fetch a single opportunity by ID
 */
async function getOpportunityById(id) {
  try {
    const { data, error } = await db
      .from('opportunities')
      .select('*')
      .eq('id', id)
      .single();
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    return { success: false, data: null, error: err.message };
  }
}

/**
 * Post a new opportunity (employer only)
 */
async function createOpportunity(opp) {
  try {
    const empId = localStorage.getItem('sm_employer_id');
    const { data, error } = await db
      .from('opportunities')
      .insert({ ...opp, employer_id: empId })
      .select()
      .single();
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    console.error('createOpportunity error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Get opportunities posted by the logged-in employer
 */
async function getMyOpportunities() {
  try {
    const empId = localStorage.getItem('sm_employer_id');
    const { data, error } = await db
      .from('opportunities')
      .select(`*, applications(count)`)
      .eq('employer_id', empId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    return { success: false, data: [], error: err.message };
  }
}


/* ── Learner profile ─────────────────────────────────────── */

/**
 * Get learner profile for the logged-in user
 */
async function getLearnerProfile() {
  try {
    const uid = localStorage.getItem('sm_uid');
    const { data, error } = await db
      .from('learners')
      .select(`*, users(first_name, last_name, email, province, phone)`)
      .eq('user_id', uid)
      .single();
    if (error) throw error;
    localStorage.setItem('sm_learner_id', data.id);
    localStorage.setItem('sm_skills', JSON.stringify(data.skills || []));
    return { success: true, data };
  } catch (err) {
    return { success: false, data: null, error: err.message };
  }
}

/**
 * Update learner profile (skills, qualification, etc.)
 */
async function updateLearnerProfile(updates) {
  try {
    const uid = localStorage.getItem('sm_uid');
    const { data, error } = await db
      .from('learners')
      .update(updates)
      .eq('user_id', uid)
      .select()
      .single();
    if (error) throw error;
    if (updates.skills) localStorage.setItem('sm_skills', JSON.stringify(updates.skills));
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}


/* ── Matches ─────────────────────────────────────────────── */

/**
 * Get AI matches for the logged-in learner
 * Returns matches joined with opportunity details, sorted by score
 */
async function getMyMatches() {
  try {
    const learnerId = localStorage.getItem('sm_learner_id');
    const { data, error } = await db
      .from('matches')
      .select(`
        id, score, ai_insight, is_saved,
        opportunities(id, title, company, location, type, sector, stipend, is_funded, is_remote, is_urgent, closing_date, skills_req)
      `)
      .eq('learner_id', learnerId)
      .order('score', { ascending: false });
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    return { success: false, data: [], error: err.message };
  }
}

/**
 * Save or unsave a match
 */
async function toggleSaveMatch(matchId, saved) {
  try {
    const { error } = await db
      .from('matches')
      .update({ is_saved: saved })
      .eq('id', matchId);
    if (error) throw error;
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Insert AI-generated matches for a learner
 * Called from match.js after Claude API scoring
 */
async function saveMatches(learnerId, matchRows) {
  try {
    /* Upsert — update score if match already exists */
    const { error } = await db
      .from('matches')
      .upsert(matchRows.map(m => ({
        learner_id: learnerId,
        opp_id:     m.opp_id,
        score:      m.score,
        ai_insight: m.ai_insight
      })), { onConflict: 'learner_id,opp_id' });
    if (error) throw error;
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}


/* ── Applications ────────────────────────────────────────── */

/**
 * Apply to an opportunity
 */
async function applyToOpportunity(oppId, matchScore) {
  try {
    const learnerId = localStorage.getItem('sm_learner_id');
    const { data, error } = await db
      .from('applications')
      .insert({ learner_id: learnerId, opp_id: oppId, match_score: matchScore, status: 'applied' })
      .select()
      .single();
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    /* If duplicate (already applied), return gracefully */
    if (err.code === '23505') return { success: true, alreadyApplied: true };
    return { success: false, error: err.message };
  }
}

/**
 * Get all applications for the logged-in learner
 */
async function getMyApplications() {
  try {
    const learnerId = localStorage.getItem('sm_learner_id');
    const { data, error } = await db
      .from('applications')
      .select(`
        id, status, match_score, applied_at,
        opportunities(id, title, company, location, type, stipend)
      `)
      .eq('learner_id', learnerId)
      .order('applied_at', { ascending: false });
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    return { success: false, data: [], error: err.message };
  }
}

/**
 * Get all applicants for an employer's opportunities
 */
async function getApplicantsForEmployer() {
  try {
    const empId = localStorage.getItem('sm_employer_id');
    const { data, error } = await db
      .from('applications')
      .select(`
        id, status, match_score, applied_at,
        learners(id, qualification, skills, users(first_name, last_name, province)),
        opportunities(id, title, employer_id)
      `)
      .eq('opportunities.employer_id', empId)
      .order('match_score', { ascending: false });
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    return { success: false, data: [], error: err.message };
  }
}

/**
 * Update application status (employer action)
 */
async function updateApplicationStatus(appId, status) {
  try {
    const { error } = await db
      .from('applications')
      .update({ status })
      .eq('id', appId);
    if (error) throw error;
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}


/* ── Admin reporting ─────────────────────────────────────── */

/**
 * Get all learners with their status (admin only)
 * Uses service role key in production — here uses anon + RLS bypass view
 */
async function getAllLearners({ search, status } = {}) {
  try {
    let query = db
      .from('learners')
      .select(`
        id, qualification, institution_name, skills, avg_match_score, status,
        users(first_name, last_name, province, email)
      `);

    if (status) query = query.eq('status', status);

    const { data, error } = await query.order('avg_match_score', { ascending: false });
    if (error) throw error;

    /* Client-side search filter */
    let result = data;
    if (search) {
      const q = search.toLowerCase();
      result = data.filter(l => {
        const name = `${l.users?.first_name} ${l.users?.last_name}`.toLowerCase();
        return name.includes(q) ||
               (l.qualification || '').toLowerCase().includes(q) ||
               (l.users?.province || '').toLowerCase().includes(q) ||
               (l.institution_name || '').toLowerCase().includes(q);
      });
    }

    return { success: true, data: result };
  } catch (err) {
    return { success: false, data: [], error: err.message };
  }
}

/**
 * Get province summary stats from view
 */
async function getProvinceSummary() {
  try {
    const { data, error } = await db
      .from('vw_province_summary')
      .select('*');
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    return { success: false, data: [], error: err.message };
  }
}

/**
 * Get institution summary stats from view
 */
async function getInstitutionSummary() {
  try {
    const { data, error } = await db
      .from('vw_institution_summary')
      .select('*');
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    return { success: false, data: [], error: err.message };
  }
}

/**
 * Get monthly placement counts from view
 */
async function getMonthlyPlacements() {
  try {
    const { data, error } = await db
      .from('vw_monthly_placements')
      .select('*')
      .order('month', { ascending: true });
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    return { success: false, data: [], error: err.message };
  }
}

/**
 * Confirm a placement (admin action)
 */
async function confirmPlacement(learnerId, oppId) {
  try {
    /* Update learner status to placed */
    await db.from('learners').update({ status: 'placed' }).eq('id', learnerId);

    /* Insert placement record */
    const { error } = await db
      .from('placements')
      .insert({ learner_id: learnerId, opp_id: oppId });
    if (error && error.code !== '23505') throw error; /* ignore duplicate */

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}


/* ── Platform stats (dashboard header cards) ─────────────── */

/**
 * Get overall platform stats for admin overview
 */
async function getPlatformStats() {
  try {
    const [learners, opps, matches, placements] = await Promise.all([
      db.from('learners').select('id', { count: 'exact', head: true }),
      db.from('opportunities').select('id', { count: 'exact', head: true }).eq('is_active', true),
      db.from('matches').select('id', { count: 'exact', head: true }),
      db.from('placements').select('id', { count: 'exact', head: true }),
    ]);

    return {
      success: true,
      data: {
        totalLearners:     learners.count   || 0,
        totalOpportunities:opps.count       || 0,
        totalMatches:      matches.count    || 0,
        totalPlacements:   placements.count || 0,
      }
    };
  } catch (err) {
    return { success: false, data: {}, error: err.message };
  }
}

/**
 * Get stats for a learner's dashboard header cards
 */
async function getLearnerStats() {
  try {
    const learnerId = localStorage.getItem('sm_learner_id');
    const [matchRes, appRes, profile] = await Promise.all([
      db.from('matches').select('score', { count: 'exact' }).eq('learner_id', learnerId),
      db.from('applications').select('id', { count: 'exact' }).eq('learner_id', learnerId),
      db.from('learners').select('avg_match_score, profile_strength').eq('id', learnerId).single(),
    ]);

    const scores      = matchRes.data?.map(m => m.score) || [];
    const topScore    = scores.length ? Math.max(...scores) : 0;
    const matchCount  = matchRes.count || 0;
    const appCount    = appRes.count   || 0;
    const strength    = profile.data?.profile_strength || 0;

    return {
      success: true,
      data: { topScore, matchCount, appCount, strength }
    };
  } catch (err) {
    return { success: false, data: {}, error: err.message };
  }
}


/* ── Utility: CSV export ─────────────────────────────────── */

/**
 * Convert an array of objects to CSV and trigger download
 */
function downloadCSV(rows, filename = 'skillsmatch_export.csv') {
  if (!rows?.length) return;
  const headers = Object.keys(rows[0]);
  const lines   = [
    headers.join(','),
    ...rows.map(r => headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(','))
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}


/* ── Real-time subscriptions ─────────────────────────────── */

/**
 * Subscribe to new applications on employer's opportunities
 * Call this from employer dashboard to get live notifications
 */
function subscribeToApplications(oppIds, callback) {
  return db
    .channel('applications-channel')
    .on('postgres_changes', {
      event:  'INSERT',
      schema: 'public',
      table:  'applications',
      filter: `opp_id=in.(${oppIds.join(',')})`
    }, payload => callback(payload.new))
    .subscribe();
}

/**
 * Unsubscribe from a channel
 */
function unsubscribe(channel) {
  db.removeChannel(channel);
}