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

function getSupabaseConfig() {
  if (typeof window === 'undefined') return null;
  const appConfig = window.APP_CONFIG || {};
  const url = appConfig.SUPABASE_URL || window.SUPABASE_URL || '';
  const anonKey = appConfig.SUPABASE_ANON_KEY || window.SUPABASE_ANON_KEY || '';
  return url && anonKey ? { url, anonKey } : null;
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
    localStorage.setItem('fb_token', session.access_token);
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
      localStorage.setItem('fb_token', data.user.token);
      const merged = { ...user, token: data.user.token, badges: data.user.badges || user.badges };
      Auth.setCurrentUser(merged);
      return merged;
    }
  } catch (error) {
    console.warn('Backend sync failed', error);
  }
  return null;
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
    const client = await initSupabaseClient();
    if (!client) return false;
    try {
      const { data: { session }, error } = await client.auth.getSession();
      if (error || !session?.user) return false;
      let user = {
        id: session.user.id,
        name: session.user.user_metadata?.full_name || session.user.user_metadata?.name || session.user.email || 'Reader',
        email: session.user.email,
        token: session.access_token,
        badges: ['New Reader'],
        avatarUrl: session.user.user_metadata?.avatar_url || null,
        provider: session.user.app_metadata?.provider || 'google'
      };
      this.setCurrentUser(user);
      await persistSupabaseProfile(session.user, session);
      const synced = await syncBackendUser(user);
      if (synced) {
        user = synced;
      }
      if (user?.token) {
        localStorage.setItem('fb_token', user.token);
      }
      this.setCurrentUser(user);
      return true;
    } catch (error) {
      console.warn('Supabase session restore failed', error);
      return false;
    }
  },
  saveUsers(users) {
    localStorage.setItem('fb_users', JSON.stringify(users));
  },
  getCurrentUser() {
    try {
      return JSON.parse(localStorage.getItem('fb_current') || 'null');
    } catch (error) {
      return null;
    }
  },
  setCurrentUser(user) {
    if (user) {
      localStorage.setItem('fb_current', JSON.stringify(user));
      if (user.token) {
        localStorage.setItem('fb_token', user.token);
      }
    } else {
      localStorage.removeItem('fb_current');
      localStorage.removeItem('fb_token');
    }
  },
  getSessionToken() {
    const currentUser = this.getCurrentUser();
    return currentUser?.token || localStorage.getItem('fb_token') || '';
  },
  async logout() {
    try {
      const client = await initSupabaseClient();
      if (client?.auth?.signOut) await client.auth.signOut();
    } catch (error) {
      console.warn('Supabase sign-out failed', error);
    }
    localStorage.removeItem('fb_current');
    localStorage.removeItem('fb_token');
    window.location.href = 'index.html';
  },
  async signup(name, email, password) {
    if (!name || !email || !password) return { ok: false, msg: 'All fields are required.' };
    if (password.length < 6) return { ok: false, msg: 'Password must be at least 6 characters.' };
    if (!/^\S+@\S+\.\S+$/.test(email)) return { ok: false, msg: 'Invalid email format.' };

    const client = await initSupabaseClient();
    if (client) {
      try {
        const { data, error } = await client.auth.signUp({
          email,
          password,
          options: { data: { full_name: name } }
        });
        if (!error && data.user) {
          let profile = {
            id: data.user.id,
            name: data.user.user_metadata?.full_name || data.user.user_metadata?.name || name,
            email: data.user.email,
            token: data.session?.access_token || '',
            badges: ['New Reader'],
            avatarUrl: data.user.user_metadata?.avatar_url || null,
            provider: data.user.app_metadata?.provider || 'email'
          };
          this.setCurrentUser(profile);
          await persistSupabaseProfile(data.user, data.session);
          if (data.session?.access_token) localStorage.setItem('fb_token', data.session.access_token);
          const synced = await syncBackendUser(profile);
          if (synced) {
            profile = synced;
            this.setCurrentUser(profile);
          }
          return { ok: true, msg: data.session ? 'Account created and signed in.' : 'Account created. Confirm your email to sign in.', user: profile };
        }
        if (error) return { ok: false, msg: error.message || 'Unable to create Supabase account.' };
      } catch (error) {
        return { ok: false, msg: error.message || 'Unable to create Supabase account.' };
      }
    }

    const response = await fetch(`${API_BASE}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    });
    const data = await parseApiResponse(response, { ok: false, msg: 'Unable to reach the Wimpy Books server.' });

    if (data.ok) {
      localStorage.setItem('fb_token', data.user.token);
      this.setCurrentUser({ ...data.user, badges: data.user.badges || ['New Reader'] });
    }
    return data;
  },
  async login(email, password) {
    const client = await initSupabaseClient();
    if (client) {
      try {
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (!error && data.user) {
          let profile = {
            id: data.user.id,
            name: data.user.user_metadata?.full_name || data.user.user_metadata?.name || data.user.email || 'Reader',
            email: data.user.email,
            token: data.session?.access_token || '',
            badges: ['New Reader'],
            avatarUrl: data.user.user_metadata?.avatar_url || null,
            provider: data.user.app_metadata?.provider || 'google'
          };
          this.setCurrentUser(profile);
          await persistSupabaseProfile(data.user, data.session);
          if (data.session?.access_token) localStorage.setItem('fb_token', data.session.access_token);
          const synced = await syncBackendUser(profile);
          if (synced) {
            profile = synced;
            this.setCurrentUser(profile);
          }
          return { ok: true, msg: 'Signed in successfully.', user: profile };
        }
        if (error) return { ok: false, msg: error.message || 'Unable to sign in.' };
      } catch (error) {
        return { ok: false, msg: error.message || 'Unable to sign in.' };
      }
    }

    const response = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await parseApiResponse(response, { ok: false, msg: 'Unable to reach the Wimpy Books server.' });
    if (data.ok) {
      localStorage.setItem('fb_token', data.user.token);
      this.setCurrentUser({ ...data.user, badges: data.user.badges || ['New Reader'] });
    }
    return data;
  },
  requireLogin(redirect = 'auth.html') {
    if (!this.getCurrentUser()) {
      window.location.href = redirect;
      return false;
    }
    return true;
  }
};

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
        Authorization: `Bearer ${localStorage.getItem('fb_token') || ''}`
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
        Authorization: `Bearer ${localStorage.getItem('fb_token') || ''}`
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
        Authorization: `Bearer ${localStorage.getItem('fb_token') || ''}`
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
        Authorization: `Bearer ${localStorage.getItem('fb_token') || ''}`
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
  async createCheckout(id) {
    const response = await fetch(`${API_BASE}/checkout/create-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('fb_token') || ''}`
      },
      body: JSON.stringify({ bookId: id })
    });
    return parseApiResponse(response, { ok: false, msg: 'Unable to reach the Wimpy Books server.' });
  },
  async delete(id) {
    const response = await fetch(`${API_BASE}/books/${id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${localStorage.getItem('fb_token') || ''}`
      }
    });
    return parseApiResponse(response, { ok: false, msg: 'Unable to reach the Wimpy Books server.' });
  },
  async getAccess(id) {
    try {
      const response = await fetch(`${API_BASE}/books/${id}/access`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('fb_token') || ''}`
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
        Authorization: `Bearer ${localStorage.getItem('fb_token') || ''}`
      }
    });
    return parseApiResponse(response, { ok: false, msg: 'Unable to reach the Wimpy Books server.' });
  },
  async saveProgress(id, position) {
    const response = await fetch(`${API_BASE}/books/${id}/progress`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('fb_token') || ''}`
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
          Authorization: `Bearer ${localStorage.getItem('fb_token') || ''}`
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
  const old = nav.querySelector('.nav-auth');
  if (old) old.remove();

  const li = document.createElement('a');
  li.className = 'nav-auth';
  if (user) {
    li.href = '#';
    li.innerHTML = `👤 ${user.name.split(' ')[0]} ▾`;
    li.onclick = (e) => {
      e.preventDefault();
      if (confirm(`Logout as ${user.name}?`)) Auth.logout();
    };
  } else {
    li.href = 'auth.html';
    li.innerHTML = '🔐 Login';
  }
  nav.appendChild(li);
}

function applyTheme(theme = 'light') {
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
  const savedTheme = localStorage.getItem('wimpybooks-theme') || 'light';
  applyTheme(savedTheme);
  btn.onclick = toggleDarkMode;
}

window.toggleDarkMode = toggleDarkMode;
window.showToast = showToast;

document.addEventListener('DOMContentLoaded', async () => {
  updateNav();
  updateThemeToggle();
  const savedTheme = localStorage.getItem('wimpybooks-theme') || 'light';
  applyTheme(savedTheme);
  await Auth.restoreSupabaseSession();
  updateNav();
});