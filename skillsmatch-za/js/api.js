/* ============================================================
   SkillsMatch ZA — api.js  (fixed)
   Supabase client + all data functions.

   SETUP — replace these two values:
   1. Supabase Dashboard → Settings → API → Project URL
   2. Supabase Dashboard → Settings → API → anon/public key

   Add to EVERY page before closing </body>:
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="js/api.js"></script>
   ============================================================ */

const SUPABASE_URL  = 'https://xykfvlyidatykliocqam.supabase.co'; // ← your URL
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5a2Z2bHlpZGF0eWtsaW9jcWFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTIxMDcsImV4cCI6MjA4OTU4ODEwN30.QVWRWctF5y26pHBzjhWHpjJ2N2cmAuiYmgyPDIjFb3g';

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    autoRefreshToken: true,
    persistSession:   true,
    detectSessionInUrl: false
  }
});

// Force session restore from localStorage on every page load.
// Supabase stores the JWT in localStorage under a specific key —
// calling getSession() reattaches it to the client before any queries run.
db.auth.getSession().then(({ data: { session } }) => {
  if (session) {
    // Session restored — update auth flag in case it was cleared
    localStorage.setItem('sm_auth', 'true');
  }
});


/* ============================================================
   AUTH
   ============================================================ */

/**
 * Register a brand-new user.
 * Creates Supabase Auth account → inserts into public.users →
 * auto-trigger creates learner/employer row → saves all IDs to localStorage.
 */
async function registerUser({ email, password, role, firstName, lastName, province, phone,
                               companyName, institutionType, institutionName, qualification, studyField, skills,
                               qualifications, certificates, linkedin_url, github_url, cv_url, city }) {
  try {
    /* Step 1: Create Supabase Auth account */
    const { data: authData, error: authErr } = await db.auth.signUp({ email, password });
    if (authErr) throw authErr;

    const authId = authData.user?.id;
    if (!authId) throw new Error('Auth signup did not return a user ID.');

    // Attach the session to the client immediately so subsequent DB calls use the user's JWT
    if (authData.session) {
      await db.auth.setSession({
        access_token:  authData.session.access_token,
        refresh_token: authData.session.refresh_token,
      });
    }

    /* Step 2: Insert public profile row */
    const { data: userRow, error: userErr } = await db
      .from('users')
      .insert({
        auth_id:    authId,
        role,
        email,
        first_name: firstName  || '',
        last_name:  lastName   || '',
        province:   province   || '',
        phone:      phone      || ''
      })
      .select('id, role, email, first_name, last_name, province')
      .single();

    if (userErr) throw userErr;

    /* Step 3: Save core identity to localStorage */
    const fullName = `${firstName || ''} ${lastName || companyName || ''}`.trim();
    localStorage.setItem('sm_auth',  'true');
    localStorage.setItem('sm_role',  role);
    localStorage.setItem('sm_email', email);
    localStorage.setItem('sm_name',  fullName);
    localStorage.setItem('sm_uid',   userRow.id);
    if (authData.session?.access_token) {
      localStorage.setItem('sm_access_token', authData.session.access_token);
    }

    /* Step 4: Wait briefly for the DB trigger to create learner/employer row, then upsert details */
    await new Promise(r => setTimeout(r, 800));

    if (role === 'learner') {
      // First try update (trigger may have created the row)
      let { data: learnerRow, error: lErr } = await db
        .from('learners')
        .update({
          institution_type: institutionType || '',
          institution_name: institutionName || '',
          qualification:    qualification   || '',
          study_field:      studyField      || '',
          skills:           skills          || [],
          qualifications:   qualifications  || [],
          certificates:     certificates    || [],
          linkedin_url:     linkedin_url    || '',
          github_url:       github_url      || '',
          cv_url:           cv_url          || '',
          city:             city            || '',
          profile_strength: _calcStrength({ qualification, institutionName, skills })
        })
        .eq('user_id', userRow.id)
        .select('id')
        .single();

      // If trigger hasn't fired yet, insert directly
      if (lErr || !learnerRow) {
        const ins = await db
          .from('learners')
          .insert({
            user_id:          userRow.id,
            institution_type: institutionType || '',
            institution_name: institutionName || '',
            qualification:    qualification   || '',
            study_field:      studyField      || '',
            skills:           skills          || [],
            qualifications:   qualifications  || [],
            certificates:     certificates    || [],
            linkedin_url:     linkedin_url    || '',
            github_url:       github_url      || '',
            cv_url:           cv_url          || '',
            city:             city            || '',
            profile_strength: _calcStrength({ qualification, institutionName, skills })
          })
          .select('id')
          .single();
        learnerRow = ins.data;
      }

      if (learnerRow) {
        localStorage.setItem('sm_learner_id', learnerRow.id);
        localStorage.setItem('sm_skills', JSON.stringify(skills || []));
      }
    }

    if (role === 'employer') {
      let { data: empRow, error: eErr } = await db
        .from('employers')
        .update({ company_name: companyName || firstName || 'Company' })
        .eq('user_id', userRow.id)
        .select('id')
        .single();

      if (eErr || !empRow) {
        const ins = await db
          .from('employers')
          .insert({ user_id: userRow.id, company_name: companyName || firstName || 'Company' })
          .select('id')
          .single();
        empRow = ins.data;
      }

      if (empRow) localStorage.setItem('sm_employer_id', empRow.id);
    }

    return { success: true, user: userRow };
  } catch (err) {
    console.error('registerUser error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Log in an existing user.
 * Fetches profile, resolves learner_id / employer_id, saves everything to localStorage.
 */
async function loginUser({ email, password }) {
  try {
    /* Sign in with Supabase Auth */
    const { data: authData, error: authErr } = await db.auth.signInWithPassword({ email, password });
    if (authErr) throw authErr;

    // Store session tokens so the client can reattach on refresh
    if (authData.session) {
      await db.auth.setSession({
        access_token:  authData.session.access_token,
        refresh_token: authData.session.refresh_token,
      });
    }

    const authUserId = authData.user.id;

    // Fetch profile — use maybeSingle so a missing row doesn't throw
    const { data: profile } = await db
      .from('users')
      .select('id, role, email, first_name, last_name, province')
      .eq('auth_id', authUserId)
      .maybeSingle();

    if (!profile) {
      throw new Error('Profile not found. Please register first or check your email confirmation.');
    }

    const fullName = ((profile.first_name || '') + ' ' + (profile.last_name || '')).trim();
    localStorage.setItem('sm_auth',  'true');
    localStorage.setItem('sm_role',  profile.role);
    localStorage.setItem('sm_email', profile.email || email);
    localStorage.setItem('sm_name',  fullName || email);
    localStorage.setItem('sm_uid',   profile.id);
    // Store access token so the Edge Function proxy can verify auth
    if (authData.session?.access_token) {
      localStorage.setItem('sm_access_token', authData.session.access_token);
    }

    /* Resolve role-specific ID */
    await _resolveRoleId(profile.id, profile.role);

    return { success: true, profile };
  } catch (err) {
    console.error('loginUser error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Ensure learner_id / employer_id is in localStorage.
 * Reads from localStorage first (set during login/register).
 * Falls back to Supabase session only if uid is genuinely missing.
 */
async function ensureProfile() {
  const uid  = localStorage.getItem('sm_uid');
  const role = localStorage.getItem('sm_role');

  // If we have a uid, just resolve the role-specific ID if missing
  if (uid && uid !== 'null') {
    const learnerId  = localStorage.getItem('sm_learner_id');
    const employerId = localStorage.getItem('sm_employer_id');

    if (role === 'learner' && (!learnerId || learnerId === 'null')) {
      await _resolveRoleId(uid, 'learner');
    }
    if (role === 'employer' && (!employerId || employerId === 'null')) {
      await _resolveRoleId(uid, 'employer');
    }
    return true;
  }

  // uid is missing — try Supabase session as fallback
  // First check if Supabase stored a session in its own localStorage key
  const sbKey = Object.keys(localStorage).find(k =>
    k.startsWith('sb-') && k.endsWith('-auth-token')
  );
  if (sbKey) {
    try {
      const stored = JSON.parse(localStorage.getItem(sbKey) || '{}');
      const accessToken = stored.access_token || stored?.currentSession?.access_token;
      if (accessToken) {
        await db.auth.setSession({
          access_token:  accessToken,
          refresh_token: stored.refresh_token || stored?.currentSession?.refresh_token || '',
        });
      }
    } catch(e) { /* ignore parse errors */ }
  }

  const session = await db.auth.getSession().then(r => r.data?.session);
  if (!session) {
    console.warn('ensureProfile: no active Supabase session');
    return false;
  }

  const { data: profile, error: pErr } = await db
    .from('users')
    .select('id, role, email, first_name, last_name')
    .eq('auth_id', session.user.id)
    .single();

  if (pErr || !profile) {
    console.warn('ensureProfile: user row not found', pErr?.message);
    return false;
  }

  const freshUid  = profile.id;
  const freshRole = profile.role;
  const fullName  = ((profile.first_name || '') + ' ' + (profile.last_name || '')).trim();
  localStorage.setItem('sm_uid',   freshUid);
  localStorage.setItem('sm_role',  freshRole);
  localStorage.setItem('sm_email', profile.email || session.user.email || '');
  localStorage.setItem('sm_name',  fullName);
  localStorage.setItem('sm_auth',  'true');

  if (freshRole === 'learner') await _resolveRoleId(freshUid, 'learner');
  if (freshRole === 'employer') await _resolveRoleId(freshUid, 'employer');

  return true;
}

/** Internal: fetch and cache learner_id or employer_id */
async function _resolveRoleId(userId, role) {
  if (role === 'learner') {
    const { data } = await db
      .from('learners')
      .select('id, skills, qualification, institution_name, avg_match_score, profile_strength')
      .eq('user_id', userId)
      .single();
    if (data) {
      localStorage.setItem('sm_learner_id',  data.id);
      localStorage.setItem('sm_skills',      JSON.stringify(data.skills || []));
      localStorage.setItem('sm_qual',        data.qualification    || '');
      localStorage.setItem('sm_field',       data.study_field      || '');
      localStorage.setItem('sm_institution', data.institution_name || '');
    }
  }

  if (role === 'employer') {
    const { data } = await db
      .from('employers')
      .select('id')
      .eq('user_id', userId)
      .single();
    if (data) localStorage.setItem('sm_employer_id', data.id);
  }
}

/** Calculate profile strength 0–100 */
function _calcStrength({ qualification, institutionName, skills }) {
  let score = 20; // base
  if (qualification)    score += 25;
  if (institutionName)  score += 15;
  if (skills?.length)   score += Math.min(skills.length * 8, 40);
  return Math.min(score, 100);
}

/** Get current Supabase session */
async function getSession() {
  const { data: { session } } = await db.auth.getSession();
  return session;
}

/** Log out */
async function logoutUser() {
  await db.auth.signOut();
  ['sm_auth','sm_role','sm_email','sm_name','sm_uid',
   'sm_learner_id','sm_employer_id','sm_skills','sm_saved','sm_access_token'].forEach(k => localStorage.removeItem(k));
  window.location.href = 'login.html';
}


/* ============================================================
   OPPORTUNITIES
   ============================================================ */

async function getOpportunities({ type, province, sector, search } = {}, sortBy = 'newest') {
  try {
    let q = db.from('opportunities').select('*').eq('is_active', true);
    if (type     && type     !== 'all') q = q.eq('type', type);
    if (province && province !== 'all') {
      province === 'Remote' ? q = q.eq('is_remote', true) : q = q.ilike('location', `%${province}%`);
    }
    if (sector   && sector   !== 'all') q = q.ilike('sector', `%${sector}%`);
    if (search)                          q = q.or(`title.ilike.%${search}%,company.ilike.%${search}%`);
    if (sortBy === 'newest')  q = q.order('created_at',  { ascending: false });
    if (sortBy === 'closing') q = q.order('closing_date', { ascending: true });

    const { data, error } = await q;
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    console.error('getOpportunities:', err.message);
    return { success: false, data: [], error: err.message };
  }
}

async function getOpportunityById(id) {
  try {
    const { data, error } = await db.from('opportunities').select('*').eq('id', id).single();
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    return { success: false, data: null, error: err.message };
  }
}

async function createOpportunity(opp) {
  try {
    const empId = localStorage.getItem('sm_employer_id');
    const { data, error } = await db
      .from('opportunities')
      .insert({ ...opp, employer_id: empId || null })
      .select().single();
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    console.error('createOpportunity:', err.message);
    return { success: false, error: err.message };
  }
}

async function getMyOpportunities() {
  try {
    const empId = localStorage.getItem('sm_employer_id');
    if (!empId || empId === 'null') return { success: true, data: [] };
    const { data, error } = await db
      .from('opportunities')
      .select('*')
      .eq('employer_id', empId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    return { success: false, data: [], error: err.message };
  }
}


/* ============================================================
   LEARNER PROFILE
   ============================================================ */

async function getLearnerProfile() {
  try {
    await ensureProfile();
    const uid = localStorage.getItem('sm_uid');
    if (!uid || uid === 'null') throw new Error('No user ID — please log in again.');

    const { data, error } = await db
      .from('learners')
      .select('*, users(first_name, last_name, email, province, phone)')
      .eq('user_id', uid)
      .single();

    if (error) throw error;
    localStorage.setItem('sm_learner_id', data.id);
    localStorage.setItem('sm_skills', JSON.stringify(data.skills || []));
    return { success: true, data };
  } catch (err) {
    console.error('getLearnerProfile:', err.message);
    return { success: false, data: null, error: err.message };
  }
}

async function updateLearnerProfile(updates) {
  try {
    const uid = localStorage.getItem('sm_uid');
    if (!uid || uid === 'null') throw new Error('No user ID.');

    /* Recalculate strength if skills updated */
    if (updates.skills) {
      updates.profile_strength = _calcStrength({
        qualification:   updates.qualification   || localStorage.getItem('sm_qual') || '',
        institutionName: updates.institution_name || '',
        skills:          updates.skills
      });
    }

    const { data, error } = await db
      .from('learners')
      .update(updates)
      .eq('user_id', uid)
      .select().single();

    if (error) throw error;
    if (updates.skills) localStorage.setItem('sm_skills', JSON.stringify(updates.skills));
    return { success: true, data };
  } catch (err) {
    console.error('updateLearnerProfile:', err.message);
    return { success: false, error: err.message };
  }
}


/* ============================================================
   MATCHES
   ============================================================ */

async function getMyMatches() {
  try {
    await ensureProfile();
    const learnerId = localStorage.getItem('sm_learner_id');
    if (!learnerId || learnerId === 'null') return { success: true, data: [] };

    const { data, error } = await db
      .from('matches')
      .select(`id, score, ai_insight, is_saved,
               skill_gaps, skill_matches, recommendation,
               opportunities(id, title, company, location, province, type, sector,
                              stipend, is_funded, is_remote, is_urgent,
                              closing_date, skills_req, apply_url, source)`)
      .eq('learner_id', learnerId)
      .order('score', { ascending: false });

    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    console.error('getMyMatches:', err.message);
    return { success: false, data: [], error: err.message };
  }
}

async function toggleSaveMatch(matchId, saved) {
  try {
    const { error } = await db.from('matches').update({ is_saved: saved }).eq('id', matchId);
    if (error) throw error;
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function saveMatches(learnerId, matchRows) {
  try {
    if (!learnerId || learnerId === 'null' || !matchRows.length) return { success: true };
    const { error } = await db
      .from('matches')
      .upsert(
        matchRows.map(m => ({
          learner_id:     learnerId,
          opp_id:         m.opp_id,
          score:          m.score,
          ai_insight:     m.ai_insight,
          skill_gaps:     m.skill_gaps    || [],
          skill_matches:  m.skill_matches || [],
          recommendation: m.recommendation || '',
        })),
        { onConflict: 'learner_id,opp_id' }
      );
    if (error) throw error;
    return { success: true };
  } catch (err) {
    console.error('saveMatches:', err.message);
    return { success: false, error: err.message };
  }
}


/* ============================================================
   APPLICATIONS
   ============================================================ */

async function applyToOpportunity(oppId, matchScore) {
  try {
    await ensureProfile();
    const learnerId = localStorage.getItem('sm_learner_id');
    if (!learnerId || learnerId === 'null') throw new Error('Learner ID missing — please log in.');

    // Use upsert to handle duplicate applications gracefully (no 409 error)
    const { data, error } = await db
      .from('applications')
      .upsert(
        { learner_id: learnerId, opp_id: oppId, match_score: matchScore, status: 'applied' },
        { onConflict: 'learner_id,opp_id', ignoreDuplicates: true }
      )
      .select().maybeSingle();

    if (error && error.code !== '23505') throw error;
    return { success: true, data, alreadyApplied: !data };
  } catch (err) {
    if (err.code === '23505') return { success: true, alreadyApplied: true };
    console.error('applyToOpportunity:', err.message);
    return { success: false, error: err.message };
  }
}

async function getMyApplications() {
  try {
    await ensureProfile();
    const learnerId = localStorage.getItem('sm_learner_id');
    if (!learnerId || learnerId === 'null') return { success: true, data: [] };

    const { data, error } = await db
      .from('applications')
      .select(`id, status, match_score, applied_at,
               opportunities(id, title, company, location, type, stipend)`)
      .eq('learner_id', learnerId)
      .order('applied_at', { ascending: false });

    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    console.error('getMyApplications:', err.message);
    return { success: false, data: [], error: err.message };
  }
}

async function getApplicantsForEmployer() {
  try {
    const empId = localStorage.getItem('sm_employer_id');
    if (!empId || empId === 'null') return { success: true, data: [] };

    /* Get employer's opp IDs first */
    const { data: opps } = await db
      .from('opportunities')
      .select('id')
      .eq('employer_id', empId);

    if (!opps?.length) return { success: true, data: [] };
    const oppIds = opps.map(o => o.id);

    const { data, error } = await db
      .from('applications')
      .select(`id, status, match_score, applied_at,
               learners(id, qualification, skills, users(first_name, last_name, province)),
               opportunities(id, title, employer_id)`)
      .in('opp_id', oppIds)
      .order('match_score', { ascending: false });

    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    console.error('getApplicantsForEmployer:', err.message);
    return { success: false, data: [], error: err.message };
  }
}

async function updateApplicationStatus(appId, status) {
  try {
    const { error } = await db.from('applications').update({ status }).eq('id', appId);
    if (error) throw error;
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}


/* ============================================================
   ADMIN / REPORTING
   ============================================================ */

async function getAllLearners({ search, status } = {}) {
  try {
    // Step 1: fetch learners (admin RLS allows this via is_admin())
    let q = db
      .from('learners')
      .select('id, user_id, qualification, institution_name, skills, avg_match_score, status');
    if (status) q = q.eq('status', status);
    const { data: learners, error: lErr } = await q.order('avg_match_score', { ascending: false });
    if (lErr) throw lErr;
    if (!learners?.length) return { success: true, data: [] };

    // Step 2: fetch corresponding users rows separately.
    // Doing a join inside .select() re-evaluates the users RLS policy
    // in a context where is_admin() may not yet have the JWT claim,
    // causing the join to silently return null. Two queries avoids this.
    const userIds = [...new Set(learners.map(l => l.user_id).filter(Boolean))];
    const { data: users } = await db
      .from('users')
      .select('id, first_name, last_name, province, email')
      .in('id', userIds);

    // Build a lookup map
    const userMap = {};
    (users || []).forEach(u => { userMap[u.id] = u; });

    // Merge
    let result = learners.map(l => ({
      ...l,
      users: userMap[l.user_id] || null
    }));

    if (search) {
      const s = search.toLowerCase();
      result = result.filter(l => {
        const u = l.users || {};
        const n = `${u.first_name||''} ${u.last_name||''}`.toLowerCase();
        return n.includes(s) || (l.qualification||'').toLowerCase().includes(s) || (u.province||'').toLowerCase().includes(s);
      });
    }
    return { success: true, data: result };
  } catch (err) {
    console.error('getAllLearners:', err.message);
    return { success: false, data: [], error: err.message };
  }
}

async function getProvinceSummary() {
  try {
    const { data, error } = await db.from('vw_province_summary').select('*');
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    return { success: false, data: [], error: err.message };
  }
}

async function getInstitutionSummary() {
  try {
    const { data, error } = await db.from('vw_institution_summary').select('*');
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    return { success: false, data: [], error: err.message };
  }
}

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

async function confirmPlacement(learnerId, oppId) {
  try {
    await db.from('learners').update({ status: 'placed' }).eq('id', learnerId);
    if (oppId) {
      const { error } = await db.from('placements').insert({ learner_id: learnerId, opp_id: oppId });
      if (error && error.code !== '23505') throw error;
    }
    return { success: true };
  } catch (err) {
    console.error('confirmPlacement:', err.message);
    return { success: false, error: err.message };
  }
}

async function getPlatformStats() {
  try {
    const [l, o, m, p] = await Promise.all([
      db.from('learners').select('id',     { count: 'exact', head: true }),
      db.from('opportunities').select('id', { count: 'exact', head: true }).eq('is_active', true),
      db.from('matches').select('id',      { count: 'exact', head: true }),
      db.from('placements').select('id',   { count: 'exact', head: true }),
    ]);
    return { success: true, data: {
      totalLearners:      l.count || 0,
      totalOpportunities: o.count || 0,
      totalMatches:       m.count || 0,
      totalPlacements:    p.count || 0,
    }};
  } catch (err) {
    console.error('getPlatformStats:', err.message);
    return { success: false, data: {}, error: err.message };
  }
}

async function getLearnerStats() {
  try {
    await ensureProfile();
    const learnerId = localStorage.getItem('sm_learner_id');
    if (!learnerId || learnerId === 'null') return { success: true, data: { topScore:0, matchCount:0, appCount:0, strength:0 } };

    const [matchRes, appRes, profRes] = await Promise.all([
      db.from('matches').select('score', { count: 'exact' }).eq('learner_id', learnerId),
      db.from('applications').select('id', { count: 'exact' }).eq('learner_id', learnerId),
      db.from('learners').select('avg_match_score, profile_strength').eq('id', learnerId).single(),
    ]);

    const scores   = matchRes.data?.map(m => m.score) || [];
    const topScore = scores.length ? Math.max(...scores) : 0;

    return { success: true, data: {
      topScore,
      matchCount: matchRes.count || 0,
      appCount:   appRes.count   || 0,
      strength:   profRes.data?.profile_strength || 0,
    }};
  } catch (err) {
    console.error('getLearnerStats:', err.message);
    return { success: false, data: { topScore:0, matchCount:0, appCount:0, strength:0 } };
  }
}


/* ============================================================
   UTILITIES
   ============================================================ */

function downloadCSV(rows, filename = 'export.csv') {
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

function subscribeToApplications(oppIds, callback) {
  return db
    .channel('new-applications')
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'applications',
      filter: `opp_id=in.(${oppIds.join(',')})`
    }, payload => callback(payload.new))
    .subscribe();
}

function unsubscribe(channel) { db.removeChannel(channel); }

/* ============================================================
   EMPLOYER PROFILE
   ============================================================ */

async function getEmployerProfile() {
  try {
    await ensureProfile();
    const uid = localStorage.getItem('sm_uid');
    if (!uid || uid === 'null') throw new Error('No user ID — please log in again.');
    const { data, error } = await db
      .from('employers')
      .select('*, users(first_name, last_name, email, province, phone)')
      .eq('user_id', uid)
      .single();
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    console.error('getEmployerProfile:', err.message);
    return { success: false, data: null, error: err.message };
  }
}

async function updateEmployerProfile(updates) {
  try {
    const uid = localStorage.getItem('sm_uid');
    if (!uid || uid === 'null') throw new Error('No user ID.');
    // Split updates: employers table vs users table
    const { first_name, last_name, province, phone, ...empUpdates } = updates;
    const userUpdates = {};
    if (first_name !== undefined) userUpdates.first_name = first_name;
    if (last_name  !== undefined) userUpdates.last_name  = last_name;
    if (province   !== undefined) userUpdates.province   = province;
    if (phone      !== undefined) userUpdates.phone      = phone;
    const ops = [];
    if (Object.keys(empUpdates).length) {
      ops.push(db.from('employers').update(empUpdates).eq('user_id', uid));
    }
    if (Object.keys(userUpdates).length) {
      ops.push(db.from('users').update(userUpdates).eq('id', uid));
    }
    await Promise.all(ops);
    // Refresh localStorage name
    if (first_name || last_name) {
      const fn = first_name || localStorage.getItem('sm_name')?.split(' ')[0] || '';
      const ln = last_name  || localStorage.getItem('sm_name')?.split(' ')[1] || '';
      localStorage.setItem('sm_name', `${fn} ${ln}`.trim());
    }
    return { success: true };
  } catch (err) {
    console.error('updateEmployerProfile:', err.message);
    return { success: false, error: err.message };
  }
}

async function updateOpportunity(oppId, updates) {
  try {
    const { data, error } = await db
      .from('opportunities')
      .update(updates)
      .eq('id', oppId)
      .select()
      .single();
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    console.error('updateOpportunity:', err.message);
    return { success: false, error: err.message };
  }
}

async function deleteOpportunity(oppId) {
  try {
    const { error } = await db.from('opportunities').update({ is_active: false }).eq('id', oppId);
    if (error) throw error;
    return { success: true };
  } catch (err) {
    console.error('deleteOpportunity:', err.message);
    return { success: false, error: err.message };
  }
}

/* Also update the users table fields for a learner (name, province, phone) */
async function updateUserDetails(updates) {
  try {
    const uid = localStorage.getItem('sm_uid');
    if (!uid || uid === 'null') throw new Error('No user ID.');
    const { error } = await db.from('users').update(updates).eq('id', uid);
    if (error) throw error;
    if (updates.first_name || updates.last_name) {
      const fn = updates.first_name || localStorage.getItem('sm_name')?.split(' ')[0] || '';
      const ln = updates.last_name  || localStorage.getItem('sm_name')?.split(' ').slice(1).join(' ') || '';
      localStorage.setItem('sm_name', `${fn} ${ln}`.trim());
    }
    return { success: true };
  } catch (err) {
    console.error('updateUserDetails:', err.message);
    return { success: false, error: err.message };
  }
}

/* ============================================================
   NOTIFICATIONS
   ============================================================ */
async function getNotifications(limit = 20) {
  try {
    await ensureProfile();
    const uid = localStorage.getItem('sm_uid');
    if (!uid || uid === 'null') return { success: true, data: [] };
    const { data, error } = await db
      .from('notifications').select('*').eq('user_id', uid)
      .order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    console.error('getNotifications:', err.message);
    return { success: false, data: [] };
  }
}
async function markNotificationsRead(notifId = null) {
  try {
    const uid = localStorage.getItem('sm_uid');
    if (!uid || uid === 'null') return;
    let q = db.from('notifications').update({ is_read: true }).eq('user_id', uid);
    if (notifId) q = q.eq('id', notifId);
    await q;
  } catch (err) { console.error('markNotificationsRead:', err.message); }
}
async function notifyLearner({ userId, learnerEmail, learnerName, oppTitle, employerName, newStatus }) {
  const PROXY = SUPABASE_URL + '/functions/v1/claude-proxy';
  const titles = {
    under_review:'Your application is under review', shortlisted:'You have been shortlisted!',
    interview:'Interview invitation!', approved:'Application approved!',
    rejected:'Application update from ' + (employerName||'employer'),
    placed:'Congratulations - you have been placed!',
  };
  const msgs = {
    under_review: 'Hi ' + learnerName + ', your application for ' + oppTitle + ' at ' + employerName + ' is under review.',
    shortlisted:  'Great news, ' + learnerName + '! You have been shortlisted for ' + oppTitle + ' at ' + employerName + '.',
    interview:    'You are invited for an interview for ' + oppTitle + ' at ' + employerName + ', ' + learnerName + '!',
    approved:     'Congratulations, ' + learnerName + '! Your application for ' + oppTitle + ' at ' + employerName + ' has been approved.',
    rejected:     'Thank you, ' + learnerName + '. ' + employerName + ' will not be moving forward with your application for ' + oppTitle + '. Keep going!',
    placed:       'Congratulations, ' + learnerName + '! You have been placed at ' + employerName + ' for ' + oppTitle + '.',
  };
  try {
    const { data: { session } } = await db.auth.getSession();
    await fetch(PROXY, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+(session?.access_token||''), 'X-Action':'notify' },
      body: JSON.stringify({ userId, learnerEmail, learnerName, title: titles[newStatus]||'Update', message: msgs[newStatus]||'', type: newStatus==='rejected'?'warning':'success', link:'dashboard.html#l-apps', newStatus, oppTitle, employerName }),
    });
  } catch(e) { console.warn('notifyLearner:', e.message); }
}