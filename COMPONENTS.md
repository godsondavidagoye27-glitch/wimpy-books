# Wimpy Books — Shared UI Components

This document describes the standard, reusable components across the Wimpy Books site.

## Standard Navigation

All pages use a consistent navigation bar. To maintain consistency, use this standard template:

```html
<nav class="one">
  <a class="nav-logo" href="index.html" aria-label="Wimpy Books home">
    <img src="logo.svg" alt="Wimpy Books logo" width="40" height="40">
    <span>Wimpy Books</span>
  </a>
  <a href="store.html">📚 Store</a>
  <a href="upload.html">⬆️ Upload</a>
  <a href="contacts.html">📞 Contacts</a>
  <button class="theme-toggle" id="themeToggle" type="button">🌙</button>
</nav>
```

### Navigation Variants by Page

- **Index/Home** (`index.html`): Full navigation with theme toggle
- **Store** (`store.html`): Full navigation with theme toggle
- **Dashboard** (`dashboard.html`): Full navigation with dashboard active
- **Reader** (`reader.html`): Back button instead of full nav, with controls and theme toggle
- **Auth** (`auth.html`): May have minimal or no navigation during login flow
- **Upload** (`upload.html`): Full navigation with upload active
- **Contacts** (`contacts.html`): Full navigation with contacts active
- **Preview/Display** (`preview.html`, `display.html`): Full navigation with theme toggle
- **Legal** (`terms.html`, `privacy.html`): Full navigation without active state

### Future Consolidation

To fully deduplicate nav markup, consider:

1. **Build System Approach**: Use a build tool (Vite, Parcel, Webpack) with an HTML templating plugin to generate pages from templates
2. **Server-Side Approach**: Move to a framework (Express/Handlebars, Next.js, etc.) that supports template partials
3. **Web Components Approach**: Create a custom `<wimpy-nav>` web component that self-injects the nav HTML
4. **Dynamic Injection Approach**: Use a shared utility function to inject nav on page load (simplest for static sites)

### Current Status

Navigation markup is currently duplicated across 12+ HTML files. This is acceptable for a static site but should be consolidated if the site grows or undergoes frequent nav updates.

---

## Footer

All pages use a consistent footer:

```html
<footer class="leg">
  <p>© 2026 Wimpy Books. Built for readers, by readers. 📖</p>
</footer>
```

Some pages include additional footer links (e.g., links to privacy/terms).

---

## Button Styles

Standard buttons follow this pattern:

```html
<a href="#" class="btn-primary">Primary Action</a>
<a href="#" class="btn-outline">Secondary Action</a>
<button class="btn-small">Small Button</button>
<button class="btn-ghost">Ghost Button</button>
```

---

## Color Scheme

The site uses CSS variables for theming:

- `--accent`: Gold (#D4AF37) — primary brand color
- `--text`: Light off-white (#F2EFE9) — main text
- `--muted`: Muted gray (rgba) — secondary text
- `--panel`: Dark blue (#12213F) — card/panel background
- `--surface`: Translucent white — surface background
- `--border`: Gold with transparency — border color
- `--success`: Green (#2F7D5F) — success state
- `--danger`: Red (#B4402C) — error/danger state

Light theme provides inverted colors for readability.
