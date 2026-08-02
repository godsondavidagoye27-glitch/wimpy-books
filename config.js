// Loads /env.json (if present) and initializes Supabase/Firebase scaffolds.
window.APP_CONFIG_PROMISE = (async function () {
  try {
    const res = await fetch('/env.json');
    if (!res.ok) return window.APP_CONFIG || {};
    const cfg = await res.json();
    window.APP_CONFIG = cfg || {};
    if (cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY) {
      if (window.SupabaseClient && window.SupabaseClient.init) {
        window.SupabaseClient.init(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
        console.info('Supabase initialized');
      }
    }
    if (cfg.FIREBASE_CONFIG) {
      try {
        if (window.FirebaseClient && window.FirebaseClient.init) {
          window.FirebaseClient.init(cfg.FIREBASE_CONFIG);
          console.info('Firebase initialized');
        }
      } catch (err) {
        console.warn('Firebase config parse or init failed', err);
      }
    }
  } catch (err) {
    console.warn('env.json load failed', err);
  }
  return window.APP_CONFIG || {};
})();
