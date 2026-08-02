(async function () {
  async function getConfig() {
    if (window.APP_CONFIG_PROMISE) {
      await window.APP_CONFIG_PROMISE;
    }
    const appConfig = window.APP_CONFIG || {};
    const url = appConfig.SUPABASE_URL || window.SUPABASE_URL || '';
    const anonKey = appConfig.SUPABASE_ANON_KEY || window.SUPABASE_ANON_KEY || '';
    return url && anonKey ? { url, anonKey } : null;
  }

  async function getClient() {
    if (window.SupabaseClient?.get) {
      const existing = window.SupabaseClient.get();
      if (existing) return existing;
    }
    const config = await getConfig();
    if (!config) return null;
    if (window.SupabaseClient?.init) {
      window.SupabaseClient.init(config.url, config.anonKey);
      return window.SupabaseClient.get();
    }
    if (window.supabase?.createClient) {
      const client = window.supabase.createClient(config.url, config.anonKey);
      window.WimpyBootstrapSupabase = client;
      return client;
    }
    return null;
  }

  async function setSessionFromHash(client) {
    const hash = window.location.hash || '';
    if (!hash.includes('access_token=')) return false;
    const params = new URLSearchParams(hash.substring(1));
    const access_token = params.get('access_token');
    const refresh_token = params.get('refresh_token');
    if (!access_token || !refresh_token) return false;
    try {
      const result = await client.auth.setSession({ access_token, refresh_token });
      if (result.error) {
        console.warn('WimpyBooks session bootstrap: setSession failed', result.error);
        return false;
      }
      history.replaceState(null, '', window.location.pathname + window.location.search);
      return true;
    } catch (error) {
      console.warn('WimpyBooks session bootstrap error', error);
      return false;
    }
  }

  async function setSessionFromCodeExchange(client) {
    try {
      const qs = window.location.search || '';
      if (!qs.includes('code=')) return false;
      // Supabase JS v2 supports exchanging the full query string for PKCE/code flows
      const result = await client.auth.exchangeCodeForSession(qs);
      if (result.error) {
        console.warn('WimpyBooks session bootstrap: exchangeCodeForSession failed', result.error);
        return false;
      }
      // clear the URL params
      history.replaceState(null, '', window.location.pathname + window.location.hash);
      return true;
    } catch (err) {
      console.warn('WimpyBooks session bootstrap: code exchange error', err);
      return false;
    }
  }

  function markSessionReady(detail) {
    window.__WimpyBootstrapSessionDetail = detail;
    if (typeof window.__WimpyBootstrapSessionResolve === 'function') {
      window.__WimpyBootstrapSessionResolve(detail);
      window.__WimpyBootstrapSessionResolve = null;
    }
  }

  window.WimpyBootstrapSessionPromise = new Promise(resolve => {
    window.__WimpyBootstrapSessionResolve = resolve;
  });

  async function bootstrap() {
    console.log('WimpyBootstrap: current URL ->', window.location.href);
    const client = await getClient();
    const sessionDetail = { session: null };
    if (!client) {
      markSessionReady(sessionDetail);
      window.dispatchEvent(new CustomEvent('wimpybooks:session-ready', { detail: sessionDetail }));
      return;
    }

    // Try hash-based token first (OAuth implicit flow / redirect)
    let restored = await setSessionFromHash(client);
    // If no access_token in hash, try PKCE/code exchange flow (?code=...)
    if (!restored) {
      restored = await setSessionFromCodeExchange(client);
    }

    try {
      const { data, error } = await client.auth.getSession();
      console.log('WimpyBootstrap: auth.getSession ->', { data, error });
      if (error) {
        console.warn('WimpyBooks session bootstrap: auth.getSession returned error', error);
      }
      sessionDetail.session = data?.session || null;
      markSessionReady(sessionDetail);
      window.dispatchEvent(new CustomEvent('wimpybooks:session-ready', { detail: sessionDetail }));
    } catch (error) {
      console.warn('WimpyBooks session bootstrap: getSession failed', error);
      markSessionReady(sessionDetail);
      window.dispatchEvent(new CustomEvent('wimpybooks:session-ready', { detail: sessionDetail }));
    }
  }

  bootstrap();
})();
