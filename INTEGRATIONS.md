Integration notes: Supabase & Firebase

This project includes small optional scaffolds for Supabase and Firebase clients:

- `supabase.js` — attaches `window.SupabaseClient` with `init(url,key)` and `get()` helpers.
- `firebase.js` — attaches `window.FirebaseClient` with `init(config)` and `getApp()` helpers.

How to use

1. Include the official SDKs in your pages (or install packages when bundling).
2. Load `supabase.js` / `firebase.js` after the SDKs.
3. Call the init functions with your project credentials from a secure place (do not hardcode secrets).

These files are intentionally lightweight; they only provide a single global helper to centralize initialization. Replace them with full SDK usage when integrating authentication, storage, or realtime features.
