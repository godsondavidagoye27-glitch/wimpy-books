// Lightweight Supabase wrapper used by the app.
(function () {
  const ns = {};
  ns.client = null;
  ns.init = function (url, key) {
    if (!url || !key) {
      console.warn('Supabase init skipped: missing URL or key');
      return null;
    }
    try {
      if (typeof window !== 'undefined' && window.supabase && window.supabase.createClient) {
        ns.client = window.supabase.createClient(url, key);
      } else if (typeof supabase !== 'undefined' && supabase.createClient) {
        ns.client = supabase.createClient(url, key);
      } else {
        console.warn('Supabase library not found. Include the SDK bundle or add the npm package.');
      }
    } catch (err) {
      console.error('Supabase init error', err);
    }
    return ns.client;
  };
  ns.get = function () { return ns.client; };
  ns.isReady = function () { return Boolean(ns.client); };
  window.SupabaseClient = ns;
})();
