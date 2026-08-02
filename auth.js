 // ============================================
// Wimpy Books Auth + Storage
// ============================================

function getApiBase() {
  if (typeof window === 'undefined') return '/api';
  if (window.location.protocol === 'file:') return 'http://127.0.0.1:3000/api';
  if (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost') {
    return `${window.location.origin}/api`;
  }
  return `${window.location.origin}/api`;
}

const API_BASE = getApiBase();

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeTextToParagraphs(value) {
  const text = escapeHtml(value || '');
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter(Boolean)
    .map(line => `<p>${line}</p>`)
    .join('');
}

function safeTextToLineBreaks(value) {
  return escapeHtml(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '<br>');
}

function safeBackgroundStyle(coverImageData, coverFallback) {
  if (typeof coverImageData === 'string') {
    const trimmed = coverImageData.trim();
    if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(trimmed) || /^https?:\/\/[^"]+$/.test(trimmed)) {
      return `background-image:url("${escapeAttribute(trimmed)}"); background-position:center; background-size:cover;`;
    }
  }
  if (typeof coverFallback === 'string' && coverFallback.trim()) {
    return `background:${escapeAttribute(coverFallback.trim())};`;
  }
  return '';
}

function getSupabaseConfig() {
  if (typeof window === 'undefined') return null;
  const appConfig = window.APP_CONFIG || {};
  const url = appConfig.SUPABASE_URL || window.SUPABASE_URL || '';
  const anonKey = appConfig.SUPABASE_ANON_KEY || window.SUPABASE_ANON_KEY || '';
  return url && anonKey ? { url, anonKey } : null;
}

function getWimpyIDSessionStorageKey() {
  return 'wimpybooks_wimpyid_session';
}

function parseWimpyIDSessionFromUrl() {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const email = params.get('email');
  if (!token || !email) return null;
  return {
    id: params.get('id') || `wimpyid:${email}`,
    email: email.trim().toLowerCase(),
    name: params.get('name') || email.split('@')[0],
    token: token.trim(),
    provider: params.get('provider') || 'wimpyid',
    avatarUrl: params.get('avatar') || null,
    badges: ['WimpyID Member'],
    signedInAt: new Date().toISOString()
  };
}

function loadWimpyIDSession() {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(getWimpyIDSessionStorageKey());
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    localStorage.removeItem(getWimpyIDSessionStorageKey());
    return null;
  }
}

function saveWimpyIDSession(session) {
  if (typeof window === 'undefined' || !session) return null;
  localStorage.setItem(getWimpyIDSessionStorageKey(), JSON.stringify(session));
  return session;
}

function clearWimpyIDSession() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(getWimpyIDSessionStorageKey());
}

function getSessionToken() {
  const s = loadWimpyIDSession();
  return s?.token || '';
}

function getCurrentUser() {
  return loadWimpyIDSession();
}

async function initSupabaseClient() {
  if (typeof window === 'undefined') return null;
  if (window.SupabaseClient?.get && window.SupabaseClient.get()) return window.SupabaseClient.get();
  const config = getSupabaseConfig();
  if (!config) return null;
  if (window.SupabaseClient?.init) {
    window.SupabaseClient.init(config.url, config.anonKey);
    return window.SupabaseClient.get();
  }
  return null;
}

async function persistSupabaseProfile(user, session) {
  const client = await initSupabaseClient();
  if (!client || !user?.id) return;
  const profile = {
    id: user.id,
    email: user.email || '',
    full_name: user.user_metadata?.full_name || user.user_metadata?.name || user.email || 'Reader',
    avatar_url: user.user_metadata?.avatar_url || null,
    provider: user.app_metadata?.provider || 'email',
    updated_at: new Date().toISOString()
  };
  try {
    await client.from('profiles').upsert(profile, { onConflict: 'id' });
  } catch (error) {
    console.warn('Could not sync Supabase profile', error);
  }
  if (session?.access_token) {
    const s = {
      id: user.id,
      email: user.email,
      name: user.user_metadata?.full_name || user.user_metadata?.name || user.email || 'Reader',
      token: session.access_token,
      provider: user.app_metadata?.provider || 'supabase'
    };
    saveWimpyIDSession(s);
  }
}

async function syncBackendUser(user) {
  if (!user?.email) return null;
  try {
    const response = await fetch(`${API_BASE}/auth/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, name: user.name, provider: user.provider })
    });
    const data = await parseApiResponse(response, { ok: false, msg: 'Unable to sync with backend.' });
    if (data.ok && data.user) {
      const merged = { ...user, token: data.user.token, badges: data.user.badges || user.badges };
      saveWimpyIDSession(merged);
      Auth.setCurrentUser(merged);
      return merged;
    }
  } catch (error) {
    console.warn('Backend sync failed', error);
  }
  return null;
}

async function restoreWimpyIDSession() {
  if (typeof window === 'undefined') return false;
  // If WimpyID redirected back with token params, persist them
  const session = parseWimpyIDSessionFromUrl();
  if (session) {
    saveWimpyIDSession(session);
    // Remove query params to clean up the URL
    try { window.history.replaceState({}, '', window.location.pathname); } catch (e) {}
    return true;
  }
  // fallback: check localStorage
  return Boolean(loadWimpyIDSession());
}

async function syncSupabaseProgress(bookId, position, timeSpent = 0) {
  const client = await initSupabaseClient();
  const currentUser = Auth?.getCurrentUser?.();
  if (!client || !currentUser?.id) return;
  try {
    await client.from('reading_progress').upsert({
      user_id: currentUser.id,
      book_id: String(bookId),
      position: Number(position || 0),
      time_spent: Number(timeSpent || 0),
      last_read_at: new Date().toISOString()
    }, { onConflict: 'user_id,book_id' });
  } catch (error) {
    console.warn('Could not sync Supabase reading progress', error);
  }
}

async function parseApiResponse(response, fallback = null) {
  const text = await response.text();
  if (!text) return fallback ?? { ok: false, msg: `Request failed (${response.status}).` };
  try {
    return JSON.parse(text);
  } catch (error) {
    return { ok: false, msg: text || `Request failed (${response.status}).` };
  }
}

const Auth = {
  getUsers() {
    return JSON.parse(localStorage.getItem('fb_users') || '[]');
  },
  async restoreSupabaseSession() {
    return restoreWimpyIDSession();
  },
  saveUsers(users) {
    localStorage.setItem('fb_users', JSON.stringify(users));
  },
  getCurrentUser() {
    return getCurrentUser();
  },
  setCurrentUser(user) {
    if (user) {
      localStorage.setItem('fb_current', JSON.stringify(user));
      saveWimpyIDSession(user);
    } else {
      localStorage.removeItem('fb_current');
      clearWimpyIDSession();
    }
  },
  getSessionToken() {
    return getSessionToken();
  },
  async logout() {
    clearWimpyIDSession();
    window.location.href = 'auth.html';
  },
  async signup() {
    return { ok: false, msg: 'WimpyID handles account creation. Sign in via WimpyID.' };
  },
  async login() {
    return { ok: false, msg: 'WimpyID handles login. Sign in via WimpyID.' };
  },
  requireLogin(redirect = 'auth.html') {
    if (!this.getCurrentUser()) {
      window.location.href = redirect;
      return false;
    }
    return true;
  }
};

function normalizeSessionUser(session) {
  if (!session?.user) return null;
  const user = session.user;
  return {
    id: user.id,
    email: user.email || '',
    name: user.user_metadata?.full_name || user.user_metadata?.name || (user.email ? user.email.split('@')[0] : 'Reader'),
    token: session.access_token || '',
    provider: user.app_metadata?.provider || 'supabase',
    avatarUrl: user.user_metadata?.avatar_url || null,
    badges: ['WimpyID Member'],
    signedInAt: new Date().toISOString()
  };
}

window.WimpyIDSession = {
  getCurrentUser,
  getToken: getSessionToken,
  async restoreSession() {
    return restoreWimpyIDSession();
  },
  async logout() {
    clearWimpyIDSession();
    window.location.href = 'auth.html';
  }
};

let hasProcessedBootstrapSession = false;

function processBootstrapSession(detail) {
  if (hasProcessedBootstrapSession) return;
  hasProcessedBootstrapSession = true;
  const session = detail?.session || null;
  if (session) {
    const normalized = normalizeSessionUser(session);
    if (normalized) {
      Auth.setCurrentUser(normalized);
    }
  }
  updateNav();
}

window.addEventListener('wimpybooks:session-ready', (event) => {
  processBootstrapSession(event?.detail || {});
});

if (window.__WimpyBootstrapSessionDetail) {
  processBootstrapSession(window.__WimpyBootstrapSessionDetail);
} else if (window.WimpyBootstrapSessionPromise) {
  window.WimpyBootstrapSessionPromise.then(processBootstrapSession).catch(() => {});
}

window.addEventListener('wimpybooks:user-data-ready', () => {
  updateNav();
});

function ensureNoticeContainer() {
  if (document.getElementById('siteNoticeContainer')) return;
  const container = document.createElement('div');
  container.id = 'siteNoticeContainer';
  container.className = 'site-notice-container';
  document.body.appendChild(container);
}

function showToast(message, type = 'info', timeout = 3500) {
  ensureNoticeContainer();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.getElementById('siteNoticeContainer').appendChild(toast);
  window.setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
    window.setTimeout(() => toast.remove(), 300);
  }, timeout);
}

function showNotice(message, type = 'info', timeout = 3500) {
  showToast(message, type, timeout);
}

async function confirmAction(message, title = 'Confirm') {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-card">
        <h3>${title}</h3>
        <p>${message}</p>
        <div class="modal-actions">
          <button class="btn-outline modal-cancel">Cancel</button>
          <button class="btn-primary modal-confirm">Continue</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    backdrop.querySelector('.modal-cancel').onclick = () => {
      backdrop.remove();
      resolve(false);
    };
    backdrop.querySelector('.modal-confirm').onclick = () => {
      backdrop.remove();
      resolve(true);
    };
  });
}

const Books = {
  async getAll() {
    try {
      const response = await fetch(`${API_BASE}/books`);
      return await parseApiResponse(response, []);
    } catch (error) {
      return JSON.parse(localStorage.getItem('fb_books') || '[]');
    }
  },
  async getById(id) {
    try {
      const response = await fetch(`${API_BASE}/books/${id}`);
      const book = await parseApiResponse(response, null);
      return book && typeof book === 'object' ? book : null;
    } catch (error) {
      const books = await this.getAll();
      return books.find(book => String(book.id) === String(id));
    }
  },
  async add(book) {
    const response = await fetch(`${API_BASE}/books`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getSessionToken() || ''}`,
        'x-user-email': getCurrentUser()?.email || ''
      },
      body: JSON.stringify(book)
    });
    const data = await parseApiResponse(response, { ok: false, msg: 'Unable to reach the Wimpy Books server.' });
    if (data.ok) return { ok: true, ...data.book, id: data.book?.id };
    return { ok: false, msg: data.msg || 'Could not publish this book. Please try again.' };
  },
  async comment(id, text) {
    const response = await fetch(`${API_BASE}/books/${id}/comment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getSessionToken() || ''}`,
        'x-user-email': getCurrentUser()?.email || ''
      },
      body: JSON.stringify({ text })
    });
    return parseApiResponse(response, { ok: false, msg: 'Unable to reach the Wimpy Books server.' });
  },
  async rate(id, score) {
    const response = await fetch(`${API_BASE}/books/${id}/rate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getSessionToken() || ''}`,
        'x-user-email': getCurrentUser()?.email || ''
      },
      body: JSON.stringify({ score })
    });
    return parseApiResponse(response, { ok: false, msg: 'Unable to reach the Wimpy Books server.' });
  },
  async purchase(id) {
    const response = await fetch(`${API_BASE}/books/${id}/purchase`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getSessionToken() || ''}`,
        'x-user-email': getCurrentUser()?.email || ''
      }
    });
    const data = await parseApiResponse(response, { ok: false, msg: 'Unable to reach the Wimpy Books server.' });
    if (data.ok) {
      const purchases = JSON.parse(localStorage.getItem('fb_purchases') || '[]');
      purchases.push(Number(id));
      localStorage.setItem('fb_purchases', JSON.stringify([...new Set(purchases)]));
    }
    return data;
  },
  async delete(id) {
    const response = await fetch(`${API_BASE}/books/${id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${getSessionToken() || ''}`,
        'x-user-email': getCurrentUser()?.email || ''
      }
    });
    return parseApiResponse(response, { ok: false, msg: 'Unable to reach the Wimpy Books server.' });
  },
  async getAccess(id) {
    try {
      const response = await fetch(`${API_BASE}/books/${id}/access`, {
        headers: {
            Authorization: `Bearer ${getSessionToken() || ''}`,
            'x-user-email': getCurrentUser()?.email || ''
          }
      });
      const data = await parseApiResponse(response, null);
      if (!data) {
        return { ok: false, msg: `Unable to parse access response (${response.status}).` };
      }
      return data.ok ? data : { ok: false, msg: data.msg || `Access denied (${response.status}).` };
    } catch (error) {
      return { ok: false, msg: 'Unable to connect to the server for access check.' };
    }
  },
  async getProgress(id) {
    const response = await fetch(`${API_BASE}/books/${id}/progress`, {
      headers: {
        Authorization: `Bearer ${getSessionToken() || ''}`,
        'x-user-email': getCurrentUser()?.email || ''
      }
    });
    return parseApiResponse(response, { ok: false, msg: 'Unable to reach the Wimpy Books server.' });
  },
  async saveProgress(id, position) {
    const response = await fetch(`${API_BASE}/books/${id}/progress`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getSessionToken() || ''}`,
        'x-user-email': getCurrentUser()?.email || ''
      },
      body: JSON.stringify({ position })
    });
    return parseApiResponse(response, { ok: false, msg: 'Unable to reach the Wimpy Books server.' });
  },
  async savePage(id, pageIndex) {
    try {
      localStorage.setItem(`fb_reader_page_${id}`, String(pageIndex));
      syncSupabaseProgress(id, pageIndex);
      return await this.saveProgress(id, pageIndex);
    } catch (err) {
      return { ok: false, msg: 'Unable to save page progress locally.' };
    }
  },
  async getFileContent(id) {
    try {
      const response = await fetch(`${API_BASE}/books/${id}/file`, {
        headers: {
            Authorization: `Bearer ${getSessionToken() || ''}`,
            'x-user-email': getCurrentUser()?.email || ''
          }
      });
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      if (!response.ok) {
        const body = await response.text();
        return { ok: false, msg: body || `File request failed (${response.status}).`, contentType };
      }
      const isText = contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('xml');
      const body = isText ? await response.text() : await response.arrayBuffer();
      return { ok: true, body, contentType, isText };
    } catch (error) {
      return { ok: false, msg: 'Unable to reach the Wimpy Books server.', contentType: 'application/octet-stream' };
    }
  }
};

function updateNav() {
  const user = Auth.getCurrentUser();
  const nav = document.querySelector('.one');
  if (!nav) return;

  let authLink = nav.querySelector('.nav-auth') || document.getElementById('navAuth');
  if (authLink && !authLink.classList.contains('nav-auth')) {
    authLink.classList.add('nav-auth');
  }
  if (!authLink) {
    authLink = document.createElement('a');
    authLink.className = 'nav-auth';
    const themeButton = nav.querySelector('#themeToggle');
    if (themeButton) {
      nav.insertBefore(authLink, themeButton);
    } else {
      nav.appendChild(authLink);
    }
  }

  if (user) {
    authLink.href = '#';
    authLink.innerHTML = `👤 ${user.name.split(' ')[0]} ▾`;
    authLink.onclick = (e) => {
      e.preventDefault();
      if (confirm(`Logout as ${user.name}?`)) Auth.logout();
    };
  } else {
    authLink.href = 'auth.html';
    authLink.innerHTML = '🔐 Account';
    authLink.onclick = null;
  }
  authLink.classList.toggle('is-user', Boolean(user));
}

function applyTheme(theme = 'dark') {
  const resolvedTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', resolvedTheme);
  document.body.classList.toggle('light-mode', resolvedTheme === 'light');
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = resolvedTheme === 'dark' ? '🌙' : '☀️';
}

function toggleDarkMode() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const nextTheme = isDark ? 'light' : 'dark';
  localStorage.setItem('wimpybooks-theme', nextTheme);
  applyTheme(nextTheme);
}

function updateThemeToggle() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const savedTheme = localStorage.getItem('wimpybooks-theme') || 'dark';
  applyTheme(savedTheme);
  btn.onclick = toggleDarkMode;
}

window.toggleDarkMode = toggleDarkMode;
window.showToast = showToast;

document.addEventListener('DOMContentLoaded', async () => {
  updateNav();
  updateThemeToggle();
  const savedTheme = localStorage.getItem('wimpybooks-theme') || 'dark';
  applyTheme(savedTheme);
  await Auth.restoreSupabaseSession();
  updateNav();
});