(function () {
  async function fetchJson(url, opts = {}) {
    try {
      const res = await fetch(url, opts);
      const text = await res.text();
      if (!text) return null;
      return JSON.parse(text);
    } catch (err) {
      return null;
    }
  }

  function getSessionUser(session) {
    return session?.user || null;
  }

  async function loadReadingProgress(client, userId) {
    if (!client || !userId) return [];
    try {
      const { data, error } = await client.from('reading_progress').select('*').eq('user_id', userId).order('last_read_at', { ascending: false });
      if (error) return [];
      return Array.isArray(data) ? data : [];
    } catch (err) {
      return [];
    }
  }

  async function loadOwnedBooks(client, userId) {
    if (!client || !userId) return [];
    try {
      const { data, error } = await client.from('book_purchases').select('book_id').eq('user_id', userId);
      if (error) return [];
      return Array.isArray(data) ? data.map(entry => String(entry.book_id)) : [];
    } catch (err) {
      return [];
    }
  }

  async function hasActiveSubscription(client, userId) {
    if (!client || !userId) return false;
    try {
      const { data, error } = await client.from('subscriptions').select('*').eq('user_id', userId).maybeSingle();
      if (error || !data) return false;
      if (!data.active) return false;
      return new Date(data.expires_at || 0) > new Date();
    } catch (err) {
      return false;
    }
  }

  function createEmptyUserState() {
    return {
      session: null,
      readingProgress: [],
      ownedBooks: [],
      hasActiveSubscription: false,
      isSignedIn: false
    };
  }

  async function getClient() {
    if (window.SupabaseClient?.get) {
      const existing = window.SupabaseClient.get();
      if (existing) return existing;
    }
    if (window.WimpyBootstrapSupabase) {
      return window.WimpyBootstrapSupabase;
    }
    if (window.APP_CONFIG_PROMISE) {
      await window.APP_CONFIG_PROMISE;
    }
    const appConfig = window.APP_CONFIG || {};
    const url = appConfig.SUPABASE_URL || window.SUPABASE_URL || '';
    const anonKey = appConfig.SUPABASE_ANON_KEY || window.SUPABASE_ANON_KEY || '';
    if (!url || !anonKey) return null;
    if (window.SupabaseClient?.init) {
      window.SupabaseClient.init(url, anonKey);
      return window.SupabaseClient.get();
    }
    if (window.supabase?.createClient) {
      const client = window.supabase.createClient(url, anonKey);
      window.WimpyBootstrapSupabase = client;
      return client;
    }
    return null;
  }

  async function resolveUserData(session) {
    const state = createEmptyUserState();

    // If Supabase session is missing, try to fall back to WimpyID session
    // stored in localStorage under `wimpybooks_wimpyid_session` so pages
    // that rely on WimpyID tokens still see a signed-in user.
    if (!session) {
      try {
        const raw = localStorage.getItem('wimpybooks_wimpyid_session');
        if (raw) {
          const w = JSON.parse(raw);
          // Normalize to a Supabase-like session shape expected by pages
          session = {
            user: {
              id: w.id || (w.email ? `wimpyid:${w.email}` : null),
              email: w.email || '',
              user_metadata: { full_name: w.name || '' },
              app_metadata: { provider: w.provider || 'wimpyid' },
              // convenience token property used in some pages
              token: w.token || ''
            },
            access_token: w.token || ''
          };
        }
      } catch (err) {
        // ignore parse errors and continue with empty state
      }
    }

    if (!session) return state;
    state.session = session;
    state.isSignedIn = true;
    const client = await getClient();
    const userId = session.user?.id;
    const [readingProgress, ownedBooks, subscriptionActive] = await Promise.all([
      loadReadingProgress(client, userId),
      loadOwnedBooks(client, userId),
      hasActiveSubscription(client, userId)
    ]);
    state.readingProgress = readingProgress;
    state.ownedBooks = ownedBooks;
    state.hasActiveSubscription = subscriptionActive;
    return state;
  }

  async function onSessionReady(event) {
    const session = event?.detail?.session || null;
    const userData = await resolveUserData(session);
    window.WimpyUser = userData;
    if (typeof window.__WimpyUserReadyResolve === 'function') {
      window.__WimpyUserReadyResolve(userData);
    }
    window.dispatchEvent(new CustomEvent('wimpybooks:user-data-ready', { detail: userData }));
  }

  function setup() {
    window.WimpyUser = createEmptyUserState();
    window.WimpyUserReady = new Promise(resolve => {
      window.__WimpyUserReadyResolve = resolve;
    });
    window.waitForWimpyUserData = async () => window.WimpyUserReady;
    window.addEventListener('wimpybooks:session-ready', onSessionReady);
    if (window.__WimpyBootstrapSessionDetail) {
      onSessionReady({ detail: window.__WimpyBootstrapSessionDetail });
    } else if (window.WimpyBootstrapSessionPromise) {
      window.WimpyBootstrapSessionPromise.then(detail => onSessionReady({ detail })).catch(() => {});
    }
  }

  setup();
})();
