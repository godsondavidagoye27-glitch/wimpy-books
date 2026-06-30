// Firebase helper scaffold — attaches to window.FirebaseClient
// Usage: include Firebase SDK scripts first, then call FirebaseClient.init(firebaseConfig)
(function () {
  const ns = {};
  ns.app = null;
  ns.init = function (config) {
    if (!config) {
      console.warn('Firebase init skipped: missing config');
      return null;
    }
    try {
      if (typeof firebase !== 'undefined' && firebase.initializeApp) {
        ns.app = firebase.initializeApp(config);
      } else if (typeof window !== 'undefined' && window.firebase && window.firebase.initializeApp) {
        ns.app = window.firebase.initializeApp(config);
      } else {
        console.warn('Firebase SDK not found. Include Firebase scripts or install firebase package for bundlers.');
      }
    } catch (err) {
      console.error('Firebase init error', err);
    }
    return ns.app;
  };
  ns.getApp = function () { return ns.app; };
  window.FirebaseClient = ns;
})();
