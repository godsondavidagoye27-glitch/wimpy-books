require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS || 'admin@wimpyco.ng').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
const UNLIMITED_PLAN_PRICE = 5000; // NGN - monthly subscription price

// Database-backed helpers (Supabase service-role client)

function sanitizeBook(book, includeFileData = false) {
  if (!book) return null;
  const sanitized = { ...book };
  // normalize field names returned from Postgres
  if (sanitized.file_data !== undefined) {
    sanitized.fileData = sanitized.file_data;
    delete sanitized.file_data;
  }
  if (!includeFileData) delete sanitized.fileData;
  return sanitized;
}

async function fetchApprovedBooks(page = 1, limit = 20) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 200));
  const start = (safePage - 1) * safeLimit;
  const end = start + safeLimit - 1;

  if (!supabaseAdmin) {
    return (localDb.book_titles || [])
      .filter(b => b.status === 'approved')
      .slice(start, end + 1)
      .map(b => sanitizeBook(b));
  }

  const { data, error } = await supabaseAdmin
    .from('book_titles')
    .select('*')
    .eq('status', 'approved')
    .order('created_at', { ascending: false })
    .range(start, end);

  if (error) {
    console.error('Supabase fetchApprovedBooks error', error);
    return [];
  }

  return (data || []).map(row => {
    const book = sanitizeBook(row);
    delete book.file_data;
    delete book.cover_image_data;
    return book;
  });
}

async function fetchBookById(bookId) {
  if (!supabaseAdmin) {
    const localBook = localDb.book_titles.find(b => Number(b.id) === Number(bookId));
    if (!localBook) return null;
    const comments = (localDb.book_comments || []).filter(c => Number(c.book_id) === Number(bookId)).map(c => ({ ...c, user_name: 'Reader' }));
    return sanitizeBook({ ...localBook, comments }, true);
  }
  const { data, error } = await supabaseAdmin.from('book_titles').select('*').eq('id', bookId).maybeSingle();
  if (error) {
    console.error('Supabase fetchBookById error', error);
    return null;
  }
  if (!data) return null;

  const { data: commentRows, error: commentsError } = await supabaseAdmin
    .from('book_comments')
    .select('*, profiles!book_comments_user_id_fkey(email, full_name)')
    .eq('book_id', bookId)
    .order('created_at', { ascending: false });
  if (!commentsError) {
    data.comments = (commentRows || []).map(comment => ({
      ...comment,
      user_name: comment.profiles?.full_name || comment.profiles?.email || 'Reader'
    }));
  }
  return sanitizeBook(data, true);
}

async function insertBookRow(payload, uploaderId) {
  if (!supabaseAdmin) {
    const id = localDb.nextId++;
    const now = new Date().toISOString();
    const book = {
      id,
      title: payload.title,
      author: payload.author,
      genre: payload.genre || null,
      description: payload.description || null,
      cover: payload.cover || null,
      cover_image_data: payload.coverImageData || null,
      preview: payload.preview || payload.description || null,
      is_free: payload.isFree !== false,
      price: Number(payload.price || 0),
      file_name: payload.fileName || null,
      file_type: payload.fileType || null,
      file_data: payload.fileData || null,
      status: 'pending',
      uploader: payload.uploader || null,
      uploader_id: uploaderId || null,
      created_at: now,
      reads: 0,
      traffic: 0,
      sales: 0,
      rating: 0,
      ratings: 0
    };
    localDb.book_titles.unshift(book);
    return sanitizeBook(book, false);
  }
  const toInsert = {
    title: payload.title,
    author: payload.author,
    genre: payload.genre || null,
    description: payload.description || null,
    cover: payload.cover || null,
    cover_image_data: payload.coverImageData || null,
    preview: payload.preview || payload.description || null,
    is_free: payload.isFree !== false,
    price: Number(payload.price || 0),
    file_name: payload.fileName || null,
    file_type: payload.fileType || null,
    file_data: payload.fileData || null,
    status: payload.status || 'pending',
    uploader_id: uploaderId,
    created_at: new Date().toISOString()
  };
  const { data, error } = await supabaseAdmin.from('book_titles').insert(toInsert).select().single();
  if (error) {
    console.error('Supabase insertBookRow error', error);
    return null;
  }
  return sanitizeBook(data, false);
}

async function updateBookRow(id, updates, uploaderId) {
  if (!supabaseAdmin) return null;
  const { data: existing } = await supabaseAdmin.from('book_titles').select('uploader_id').eq('id', id).maybeSingle();
  if (!existing) return null;
  if (existing.uploader_id !== uploaderId) return null;
  const { data, error } = await supabaseAdmin.from('book_titles').update(updates).eq('id', id).select().maybeSingle();
  if (error) {
    console.error('Supabase updateBookRow error', error);
    return null;
  }
  return sanitizeBook(data, false);
}

async function deleteBookRow(id, uploaderId) {
  if (!supabaseAdmin) {
    const idx = localDb.book_titles.findIndex(b => Number(b.id) === Number(id));
    if (idx === -1) return false;
    const book = localDb.book_titles[idx];
    if (book.uploader !== uploaderId && book.uploader_id !== uploaderId && !isAdminUser({ id: uploaderId })) return false;
    localDb.book_titles.splice(idx, 1);
    return true;
  }
  const { data: existing } = await supabaseAdmin.from('book_titles').select('uploader_id').eq('id', id).maybeSingle();
  if (!existing) return false;
  if (existing.uploader_id !== uploaderId) return false;
  const { error } = await supabaseAdmin.from('book_titles').delete().eq('id', id);
  if (error) {
    console.error('Supabase deleteBookRow error', error);
    return false;
  }
  return true;
}

async function userHasPurchased(userId, bookId) {
  if (!supabaseAdmin) {
    return localDb.purchases.some(p => String(p.user_id) === String(userId) && Number(p.book_id) === Number(bookId));
  }
  const { data, error } = await supabaseAdmin.from('book_purchases').select('id').eq('user_id', userId).eq('book_id', bookId).limit(1).maybeSingle();
  if (error) {
    console.error('Supabase userHasPurchased error', error);
    return false;
  }
  return Boolean(data);
}

async function insertPurchaseRow(userId, bookId, amount, transactionRef, chargeResponse) {
  if (!supabaseAdmin) {
    const id = Date.now();
    const entry = { id, user_id: userId, book_id: bookId, amount: amount || 0, transaction_ref: transactionRef || null, metadata: chargeResponse || null, created_at: new Date().toISOString() };
    localDb.purchases.push(entry);
    const book = localDb.book_titles.find(b => Number(b.id) === Number(bookId));
    if (book) book.sales = (book.sales || 0) + 1;
    return entry;
  }
  const { data, error } = await supabaseAdmin.from('book_purchases').insert([{ user_id: userId, book_id: bookId, amount: amount || 0, transaction_ref: transactionRef || null, metadata: chargeResponse || null, created_at: new Date().toISOString() }]).select().maybeSingle();
  if (error) {
    console.error('Supabase insertPurchaseRow error', error);
    return null;
  }
  return data;
}

async function insertCommentRow(userId, bookId, text) {
  if (!supabaseAdmin) {
    const id = Date.now();
    const entry = { id, user_id: userId, book_id: bookId, text, created_at: new Date().toISOString() };
    localDb.book_comments.push(entry);
    return entry;
  }
  const { data, error } = await supabaseAdmin.from('book_comments').insert([{ user_id: userId, book_id: bookId, text: text, created_at: new Date().toISOString() }]).select().maybeSingle();
  if (error) {
    console.error('Supabase insertCommentRow error', error);
    return null;
  }
  return data;
}

async function upsertRatingRow(userId, bookId, score) {
  if (!supabaseAdmin) {
    localDb.ratings = localDb.ratings || [];
    const entry = { id: Date.now(), user_id: userId, book_id: bookId, score: Number(score || 0), created_at: new Date().toISOString() };
    const idx = localDb.ratings.findIndex(r => String(r.user_id) === String(userId) && Number(r.book_id) === Number(bookId));
    if (idx !== -1) localDb.ratings[idx] = entry; else localDb.ratings.push(entry);
    const matching = localDb.ratings.filter(r => Number(r.book_id) === Number(bookId));
    const avg = matching.length ? matching.reduce((sum, r) => sum + Number(r.score || 0), 0) / matching.length : 0;
    const book = localDb.book_titles.find(b => Number(b.id) === Number(bookId));
    if (book) {
      book.rating = Number(avg.toFixed(2));
      book.ratings = matching.length;
    }
    return entry;
  }
  const payload = { user_id: userId, book_id: bookId, score: Number(score || 0), created_at: new Date().toISOString() };
  const { data, error } = await supabaseAdmin.from('book_ratings').upsert(payload, { onConflict: ['user_id', 'book_id'] }).select().maybeSingle();
  if (error) {
    console.error('Supabase upsertRatingRow error', error);
    return null;
  }

  const { data: ratingData, error: ratingError } = await supabaseAdmin
    .from('book_ratings')
    .select('score')
    .eq('book_id', bookId);
  if (!ratingError) {
    const scores = (ratingData || []).map(r => Number(r.score || 0));
    const avg = scores.length ? (scores.reduce((sum, v) => sum + v, 0) / scores.length) : 0;
    await supabaseAdmin.from('book_titles').update({ rating: Number(avg.toFixed(2)), ratings: scores.length }).eq('id', bookId);
  }
  return data;
}

async function getReadingProgress(userId, bookId) {
  if (!supabaseAdmin) return localDb.readingProgress.find(r => String(r.user_id) === String(userId) && Number(r.book_id) === Number(bookId)) || null;
  const { data, error } = await supabaseAdmin.from('book_reading_progress').select('*').eq('user_id', userId).eq('book_id', bookId).maybeSingle();
  if (error) {
    console.error('Supabase getReadingProgress error', error);
    return null;
  }
  return data;
}

async function upsertReadingProgress(userId, bookId, position, timeSpent) {
  if (!supabaseAdmin) {
    const now = new Date().toISOString();
    const existing = localDb.readingProgress.find(r => String(r.user_id) === String(userId) && Number(r.book_id) === Number(bookId));
    if (existing) {
      existing.position = String(position || '');
      existing.time_spent = (existing.time_spent || 0) + Number(timeSpent || 0);
      existing.last_read_at = now;
      return existing;
    }
    const entry = { id: Date.now(), user_id: userId, book_id: bookId, position: String(position || ''), time_spent: Number(timeSpent || 0), last_read_at: now };
    localDb.readingProgress.push(entry);
    return entry;
  }
  const payload = { user_id: userId, book_id: bookId, position: String(position || ''), time_spent: Number(timeSpent || 0), last_read_at: new Date().toISOString() };
  const { data, error } = await supabaseAdmin.from('book_reading_progress').upsert(payload, { onConflict: ['user_id', 'book_id'] }).select().maybeSingle();
  if (error) {
    console.error('Supabase upsertReadingProgress error', error);
    return null;
  }
  return data;
}

async function insertContactMessage(payload) {
  if (!supabaseAdmin) {
    const id = Date.now();
    const entry = { id, name: payload.name, email: payload.email, subject: payload.subject || null, message: payload.message, created_at: new Date().toISOString() };
    localDb.contacts.push(entry);
    return entry;
  }
  const { data, error } = await supabaseAdmin.from('book_contact_messages').insert([{ name: payload.name, email: payload.email, subject: payload.subject || null, message: payload.message, created_at: new Date().toISOString() }]).select().maybeSingle();
  if (error) {
    console.error('Supabase insertContactMessage error', error);
    return null;
  }
  return data;
}

async function insertNewsletterSignup(email) {
  if (!supabaseAdmin) {
    const exists = localDb.newsletter.some(n => n.email === email);
    if (exists) return { ok: false, msg: 'You are already subscribed.' };
    const entry = { id: Date.now(), email, created_at: new Date().toISOString() };
    localDb.newsletter.push(entry);
    return { ok: true, data: entry };
  }
  try {
    const { data, error } = await supabaseAdmin.from('book_newsletter_signups').insert([{ email: email, created_at: new Date().toISOString() }]).select().maybeSingle();
    if (error) {
      // handle unique violation
      if (error.code === '23505' || (error.details && error.details.includes('already exists'))) {
        return { ok: false, msg: 'You are already subscribed.' };
      }
      console.error('Supabase insertNewsletterSignup error', error);
      return { ok: false, msg: 'Unable to sign up.' };
    }
    return { ok: true, data };
  } catch (err) {
    console.error('insertNewsletterSignup exception', err);
    return { ok: false, msg: 'Unable to sign up.' };
  }
}

function getSupabaseAdminClient() {
  const url = process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const supabaseAdmin = getSupabaseAdminClient();

// In-memory fallback for local/dev testing when Supabase isn't configured
const localDb = {
  nextId: 1000,
  book_titles: [],
  book_purchases: [],
  book_subscriptions: [],
  book_reading_progress: [],
  book_comments: [],
  book_newsletter_signups: [],
  book_contact_messages: []
};

const rateLimitStore = new Map();

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        // Return a special error marker so callers can detect malformed JSON
        resolve({ __parseError: 'Invalid request body.' });
      }
    });
    req.on('error', reject);
  });
}

function sanitizeBook(book, includeFileData = false) {
  const sanitized = { ...book };
  if (!includeFileData) delete sanitized.fileData;
  return sanitized;
}

async function getTrendingBooks() {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin.from('book_titles').select('*').eq('status', 'approved').order('reads', { ascending: false }).limit(8);
  if (error) {
    console.error('getTrendingBooks error', error);
    return [];
  }
  return (data || []).map(row => sanitizeBook(row));
}

function getBookFilePayload(book) {
  if (!book || !book.fileData) {
    return { buffer: Buffer.alloc(0), contentType: 'application/octet-stream' };
  }
  const [header, body = ''] = String(book.fileData).split(',');
  const contentType = header.match(/data:([^;]+);/)?.[1] || book.fileType || 'application/octet-stream';
  const isBase64 = header.includes('base64');
  const payload = isBase64 ? body : decodeURIComponent(body);
  const buffer = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(payload);
  return { buffer, contentType };
}

function isAdminUser(user) {
  return Boolean(user?.isAdmin || ADMIN_EMAILS.has(String(user?.email || '').toLowerCase()));
}

async function authUser(req) {
  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();

  // Dev-only auth shortcut: only accept 'dev-token' if NODE_ENV is not production AND ALLOW_DEV_AUTH is explicitly true
  if (token === 'dev-token') {
    const isDev = process.env.NODE_ENV !== 'production';
    const allowDevAuth = process.env.ALLOW_DEV_AUTH === 'true';
    if (isDev && allowDevAuth) {
      return {
        id: 'dev-local-user',
        email: 'dev@example.com',
        name: 'Dev Reader',
        badges: ['New Reader'],
        isAdmin: true
      };
    }
    return null; // reject dev token in production or if flag not set
  }

  // Only valid path: verify token via Supabase
  if (!token || !supabaseAdmin) {
    return null;
  }

  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (!error && user) {
      return {
        id: user.id,
        email: user.email,
        name: user.user_metadata?.full_name || user.user_metadata?.name || user.email || 'Reader',
        badges: ['New Reader'],
        provider: user.app_metadata?.provider || 'supabase',
        isAdmin: isAdminUser({ email: user.email })
      };
    }
  } catch (error) {
    console.warn('Supabase auth lookup failed', error);
  }

  return null;
}

function validateBookPayload(body) {
  const errors = [];
  const MAX_FILE_SIZE = 100 * 1024 * 1024;
  const ALLOWED_BOOK_TYPES = ['application/pdf', 'text/plain', 'application/epub+zip', 'application/zip'];
  const ALLOWED_EXTENSIONS = ['.pdf', '.txt', '.epub'];

  if (!body.title || !String(body.title).trim()) errors.push('Book title is required.');
  if (!body.author || !String(body.author).trim()) errors.push('Author name is required.');
  if (!body.description || !String(body.description).trim()) errors.push('Description is required.');
  if (!body.fileData || !String(body.fileData).startsWith('data:')) errors.push('A valid book file is required.');
  if (body.coverImageData && !String(body.coverImageData).startsWith('data:image/')) errors.push('Cover image must be an image file.');

  if (body.fileData) {
    const [header] = String(body.fileData).split(',');
    const mimeType = header.match(/data:([^;]+);/)?.[1] || '';
    const fileName = String(body.fileName || '').toLowerCase();
    const hasAllowedExt = ALLOWED_EXTENSIONS.some(ext => fileName.endsWith(ext));
    const hasAllowedMime = ALLOWED_BOOK_TYPES.includes(mimeType);

    if (!hasAllowedMime && !hasAllowedExt) {
      errors.push('Only PDF, TXT, and EPUB files are supported.');
    }

    const base64 = String(body.fileData).split(',')[1] || '';
    const sizeInBytes = Math.ceil((base64.length * 3) / 4);
    if (sizeInBytes > MAX_FILE_SIZE) {
      errors.push('Book file is too large. Please keep uploads under 100 MB.');
    }
  }

  if (body.price !== undefined && (Number(body.price) < 0 || Number.isNaN(Number(body.price)))) {
    errors.push('Price must be a positive number.');
  }

  return errors;
}

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function validateCommentPayload(body) {
  const errors = [];
  const text = String(body.text || '').trim();
  if (!text) errors.push('Comment text is required.');
  if (text.length > 800) errors.push('Comment text must be 800 characters or fewer.');
  return errors;
}

function validateContactPayload(body) {
  const errors = [];
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const subject = String(body.subject || '').trim();
  const message = String(body.message || '').trim();
  if (!name) errors.push('Name is required.');
  if (!email || !isValidEmail(email)) errors.push('A valid email address is required.');
  if (!message) errors.push('Message is required.');
  if (name.length > 120) errors.push('Name must be 120 characters or fewer.');
  if (subject.length > 200) errors.push('Subject must be 200 characters or fewer.');
  if (message.length > 2000) errors.push('Message must be 2000 characters or fewer.');
  return errors;
}

function validateNewsletterPayload(body) {
  const errors = [];
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !isValidEmail(email)) errors.push('Please enter a valid email address.');
  if (email.length > 254) errors.push('Email address is too long.');
  return errors;
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };
  return map[ext] || 'application/octet-stream';
}

function serveStatic(req, res) {
  const reqPath = req.url.split('?')[0];
  const safePath = reqPath === '/' ? '/index.html' : reqPath;
  const fullPath = path.join(ROOT, decodeURIComponent(safePath));
  if (!fullPath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden');
    return;
  }
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    res.writeHead(200, { 'Content-Type': getContentType(fullPath) });
    res.end(fs.readFileSync(fullPath));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function enforceRateLimit(req, res) {
  const now = Date.now();
  const key = `${req.socket.remoteAddress || 'local'}:${req.url}`;
  const entry = rateLimitStore.get(key) || { count: 0, resetAt: now + 60_000 };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + 60_000;
  }
  entry.count += 1;
  rateLimitStore.set(key, entry);
  if (entry.count > 15) {
    sendJson(res, 429, { ok: false, msg: 'Too many requests. Please slow down.' });
    return false;
  }
  return true;
}

async function chargeWimpyPayWallet(userId, amount, reference, description) {
  const baseUrl = process.env.WIMPYPAY_API_URL || 'https://pay.wimpy-corp.com.ng';
  const apiKey = process.env.WIMPYPAY_INTERNAL_API_KEY;
  const endpoint = `${baseUrl.replace(/\/$/, '')}/api/external/charge-wallet`;

  if (!apiKey) {
    console.warn('Missing WIMPYPAY_INTERNAL_API_KEY for wallet charge.');
    // For local/dev test users simulate a successful charge so tests can proceed.
    if (String(userId || '').startsWith('dev') || String(userId || '').startsWith('local:')) {
      return { ok: true, transactionRef: `dev-${Date.now()}`, data: { simulated: true } };
    }
    return { ok: false, error: 'missing-api-key' };
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-api-key': apiKey
      },
      body: JSON.stringify({
        user_id: userId,
        amount: Number(amount || 0),
        currency: 'NGN',
        reference,
        description
      })
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (err) {
      payload = { raw: text };
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: payload?.error || payload?.code || 'charge_failed',
        payload
      };
    }

    return {
      ok: true,
      transactionRef: payload?.reference || payload?.transaction_reference || reference,
      data: payload
    };
  } catch (error) {
    console.error('WimpyPay wallet charge failed:', error);
    return { ok: false, error: 'network_error', payload: { message: error.message } };
  }
}

async function getUserSubscription(user) {
  if (!user) return null;
  if (supabaseAdmin) {
    try {
      const { data } = await supabaseAdmin.from('book_subscriptions').select('*').eq('user_id', user.id).maybeSingle();
      if (!data) return null;
      if (data.active && new Date(data.expires_at || 0) > new Date()) return data;
      return null;
    } catch (e) {
      return null;
    }
  }

  const localSub = localDb.book_subscriptions.find(s => (String(s.user_id) === String(user.id) || String(s.user_email) === String(user.email)) && s.active && new Date(s.expires_at || 0) > new Date());
  return localSub || null;
}

async function getBookAccess(user, book) {
  if (!book) return { canRead: false, owned: false, hasActiveSubscription: false, isFree: false };
  if (book.isFree) return { canRead: true, owned: false, hasActiveSubscription: false, isFree: true };

  const isAdmin = isAdminUser(user);
  if (isAdmin) return { canRead: true, owned: false, hasActiveSubscription: false, isFree: false };

  const hasActiveSubscription = Boolean(await getUserSubscription(user));
  let ownsBook = false;

  if (user?.id) {
    ownsBook = await userHasPurchased(user.id, book.id);
  }

  return {
    canRead: ownsBook || hasActiveSubscription || isAdmin,
    owned: ownsBook,
    hasActiveSubscription,
    isFree: Boolean(book.isFree)
  };
}

function startServer(port = PORT) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (req.method === 'POST' && url.pathname.startsWith('/api/') && !enforceRateLimit(req, res)) return;

    if (req.method === 'POST' && url.pathname === '/api/subscriptions/unlimited') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { ok: false, msg: 'Login required.' });

      const reference = `wimpybooks-unlimited-${user.id}-${Date.now()}`;
      const description = 'WimpyBooks Unlimited Monthly Subscription';

      // TODO(confirm with WimpyPay team): WimpyPay subscription flow
      // Current: One-off charge upfront + manual 30-day expiry (no auto-renewal yet)
      // Confirm:
      // 1. Does WimpyPay expose a dedicated recurring-subscription endpoint distinct from charge-wallet?
      //    If yes, we should call that instead of charge-wallet + manual expiry.
      // 2. Does WimpyPay own subscription state centrally (e.g., pay_subscriptions table)?
      //    If yes, WimpyBooks should reference pay_subscription_id, not maintain local active/expires_at.
      // 3. How should auto-renewal work? (webhook callback? periodic batch job? manual renewal?)

      // Charge the user's WimpyPay wallet first
      const chargeResult = await chargeWimpyPayWallet(user.id, UNLIMITED_PLAN_PRICE, reference, description);
      if (!chargeResult.ok) {
        if (chargeResult.error === 'insufficient-funds' || chargeResult.payload?.error === 'insufficient-funds') {
          return sendJson(res, 402, { ok: false, msg: "Your WimpyPay wallet doesn't have enough balance to subscribe — top up at pay.wimpy-corp.com.ng and try again.", topUpUrl: 'https://pay.wimpy-corp.com.ng' });
        }
        console.error('WimpyPay charge result error:', chargeResult);
        return sendJson(res, 502, { ok: false, msg: 'Unable to process the subscription charge right now. Please try again later.' });
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
      try {
        if (!supabaseAdmin) {
          const existing = localDb.book_subscriptions.find(s => String(s.user_id) === String(user.id) || String(s.user_email) === String(user.email));
          if (existing) {
            existing.active = true;
            existing.expires_at = expiresAt;
            existing.transaction_ref = chargeResult.transactionRef;
          } else {
            localDb.book_subscriptions.push({ id: Date.now(), user_id: user.id, user_email: user.email, active: true, expires_at: expiresAt, transaction_ref: chargeResult.transactionRef });
          }
          return sendJson(res, 200, { ok: true, msg: 'WimpyBooks Unlimited is now active.', expiresAt, transactionRef: chargeResult.transactionRef });
        }
        await supabaseAdmin.from('book_subscriptions').upsert([{ user_id: user.id, user_email: user.email, active: true, expires_at: expiresAt, transaction_ref: chargeResult.transactionRef }], { onConflict: ['user_id'] });
        return sendJson(res, 200, { ok: true, msg: 'WimpyBooks Unlimited is now active.', expiresAt, transactionRef: chargeResult.transactionRef });
      } catch (err) {
        console.error('subscriptions upsert error', err);
        return sendJson(res, 500, { ok: false, msg: 'Unable to activate subscription.' });
      }
    }

    if (url.pathname.startsWith('/api/books')) {
      const segments = url.pathname.split('/').filter(Boolean);
      const bookId = Number(segments[2]);
      if (req.method === 'GET' && url.pathname === '/api/books') {
        const params = new URLSearchParams(url.search);
        const page = Number(params.get('page') || '1');
        const limit = Number(params.get('limit') || '20');
        const books = await fetchApprovedBooks(page, limit);
        return sendJson(res, 200, books);
      }
      if (req.method === 'GET' && !Number.isNaN(bookId) && segments.length === 3) {
        const book = await fetchBookById(bookId);
        if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
        // if not approved, only allow uploader or admin
        if (book.status && book.status !== 'approved') {
          const user = await authUser(req);
          if (!user || (!isAdminUser(user) && user.id !== book.uploader_id && user.email !== book.uploader)) {
            return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
          }
        }
        // increment traffic counter (best-effort)
        try { await supabaseAdmin.from('book_titles').update({ traffic: (book.traffic || 0) + 1 }).eq('id', bookId); } catch (e) {}
        return sendJson(res, 200, sanitizeBook(book));
      }
      if (req.method === 'GET' && !Number.isNaN(bookId) && segments[3] === 'file') {
        const book = await fetchBookById(bookId);
        if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
        const user = await authUser(req);
        const access = await getBookAccess(user, book);
        if (!access.canRead) return sendJson(res, user ? 403 : 401, { ok: false, msg: user ? 'Access denied.' : 'Login required.' });
        const { buffer, contentType } = getBookFilePayload(book);
        if (!buffer || buffer.length === 0) return sendJson(res, 404, { ok: false, msg: 'No file content available.' });
        try { await supabaseAdmin.from('book_titles').update({ traffic: (book.traffic || 0) + 1 }).eq('id', bookId); } catch (e) {}
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': buffer.length,
          'Content-Disposition': `inline; filename="${book.file_name || 'book'}"`
        });
        return res.end(buffer);
      }
      if (req.method === 'POST' && url.pathname === '/api/books') {
        const user = await authUser(req);
        if (!user) return sendJson(res, 401, { ok: false, msg: 'Login required.' });
        const body = await parseBody(req);
        if (body.__parseError) return sendJson(res, 400, { ok: false, msg: body.__parseError });
        const validationErrors = validateBookPayload(body);
        if (validationErrors.length) return sendJson(res, 400, { ok: false, msg: validationErrors[0] });
        const inserted = await insertBookRow(body, user.id);
        if (!inserted) return sendJson(res, 500, { ok: false, msg: 'Unable to create book.' });
        return sendJson(res, 200, { ok: true, book: inserted });
      }
      if (req.method === 'POST' && segments[3] === 'purchase' && !Number.isNaN(bookId)) {
        const user = await authUser(req);
        if (!user) return sendJson(res, 401, { ok: false, msg: 'Login required.' });
        const book = await fetchBookById(bookId);
        if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
        const access = await getBookAccess(user, book);
        if (book.isFree || access.hasActiveSubscription) return sendJson(res, 200, { ok: true, msg: book.isFree ? 'Free book unlocked.' : 'Subscription already grants access to this book.', book, amount: 0 });
        const alreadyPurchased = await userHasPurchased(user.id, bookId);
        if (alreadyPurchased) return sendJson(res, 200, { ok: true, msg: 'You already own this book.', book });

        const reference = `wimpybooks-${bookId}-${Date.now()}`;
        const description = `Purchase: ${book.title}`;
        const chargeResult = await chargeWimpyPayWallet(user.id, book.price, reference, description);
        if (!chargeResult.ok) {
          if (chargeResult.error === 'insufficient-funds' || chargeResult.payload?.error === 'insufficient-funds') {
            return sendJson(res, 402, { ok: false, msg: "Your WimpyPay wallet doesn't have enough balance — top up at pay.wimpy-corp.com.ng and try again.", topUpUrl: 'https://pay.wimpy-corp.com.ng' });
          }
          console.error('WimpyPay charge result error:', chargeResult);
          return sendJson(res, 502, { ok: false, msg: 'Unable to process the payment right now. Please try again later.' });
        }

        const purchase = await insertPurchaseRow(user.id, bookId, Number(book.price || 0), chargeResult.transactionRef, chargeResult.data || null);
        if (!purchase) return sendJson(res, 500, { ok: false, msg: 'Could not record purchase.' });
        try {
          const newSales = (book.sales || 0) + 1;
          await supabaseAdmin.from('book_titles').update({ sales: newSales }).eq('id', bookId);
        } catch (e) {}
        return sendJson(res, 200, { ok: true, msg: 'Purchase successful.', book, amount: Number(book.price || 0), transactionRef: chargeResult.transactionRef });
      }
      if (req.method === 'POST' && segments[3] === 'comment' && !Number.isNaN(bookId)) {
        const user = await authUser(req);
        if (!user) return sendJson(res, 401, { ok: false, msg: 'Login required.' });
        const body = await parseBody(req);
        if (body.__parseError) return sendJson(res, 400, { ok: false, msg: body.__parseError });
        const validationErrors = validateCommentPayload(body);
        if (validationErrors.length) return sendJson(res, 400, { ok: false, msg: validationErrors[0] });
        const book = await fetchBookById(bookId);
        if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
        const inserted = await insertCommentRow(user.id, bookId, String(body.text || '').trim());
        if (!inserted) return sendJson(res, 500, { ok: false, msg: 'Could not save comment.' });
        return sendJson(res, 200, { ok: true, comment: inserted });
      }
      if (req.method === 'POST' && segments[3] === 'rate' && !Number.isNaN(bookId)) {
        const user = await authUser(req);
        if (!user) return sendJson(res, 401, { ok: false, msg: 'Login required.' });
        const body = await parseBody(req);
        if (body.__parseError) return sendJson(res, 400, { ok: false, msg: body.__parseError });
        const book = await fetchBookById(bookId);
        if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
        const score = Number(body.score || 0);
        if (!Number.isFinite(score) || score < 0 || score > 5) {
          return sendJson(res, 400, { ok: false, msg: 'Rating must be between 0 and 5.' });
        }
        const rated = await upsertRatingRow(user.id, bookId, score);
        if (!rated) return sendJson(res, 500, { ok: false, msg: 'Unable to record rating.' });
        return sendJson(res, 200, { ok: true, rating: book.rating || null, ratings: book.ratings || null });
      }
      if (req.method === 'DELETE' && !Number.isNaN(bookId)) {
        const user = await authUser(req);
        if (!user) return sendJson(res, 401, { ok: false, msg: 'Login required.' });
        const book = await fetchBookById(bookId);
        if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
        if ((book.uploader !== user.email && book.uploader_id !== user.id) && !isAdminUser(user)) return sendJson(res, 403, { ok: false, msg: 'Only the uploader can remove this book.' });
        const deleted = await deleteBookRow(bookId, user.id);
        if (!deleted) return sendJson(res, 500, { ok: false, msg: 'Unable to delete book.' });
        // remove purchases for this book
        try { await supabaseAdmin.from('book_purchases').delete().eq('book_id', bookId); } catch (e) {}
        return sendJson(res, 200, { ok: true, msg: 'Book deleted.' });
      }
      if (req.method === 'GET' && segments[3] === 'access' && !Number.isNaN(bookId)) {
        const user = await authUser(req);
        const book = await fetchBookById(bookId);
        if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
        const access = await getBookAccess(user, book);
        if (!access.canRead && !user) return sendJson(res, 401, { ok: false, msg: 'Login required to access paid books.' });
        if (!access.canRead) return sendJson(res, 403, { ok: false, msg: 'Access denied.' });
        return sendJson(res, 200, { ok: true, canRead: true, isFree: Boolean(book.isFree), owned: access.owned, hasActiveSubscription: access.hasActiveSubscription });
      }
      if (req.method === 'GET' && segments[3] === 'progress' && !Number.isNaN(bookId)) {
        const user = await authUser(req);
        if (!user) return sendJson(res, 401, { ok: false, msg: 'Login required.' });
        const book = await fetchBookById(bookId);
        if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
        const progress = await getReadingProgress(user.id, bookId);
        return sendJson(res, 200, { ok: true, position: progress ? progress.position : 0, timeSpent: progress ? progress.time_spent || 0 : 0 });
      }
      if (req.method === 'POST' && segments[3] === 'progress' && !Number.isNaN(bookId)) {
        const user = await authUser(req);
        if (!user) return sendJson(res, 401, { ok: false, msg: 'Login required.' });
        const body = await parseBody(req);
        if (body.__parseError) return sendJson(res, 400, { ok: false, msg: body.__parseError });
        const book = await fetchBookById(bookId);
        if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
        const newPosition = body.position || '';
        const addTime = Number(body.timeSpent || 0);
        const saved = await upsertReadingProgress(user.id, bookId, newPosition, addTime);
        try { await supabaseAdmin.from('book_titles').update({ reads: (book.reads || 0) + 1, traffic: (book.traffic || 0) + 1 }).eq('id', bookId); } catch (e) {}
        return sendJson(res, 200, { ok: true, position: saved ? saved.position : newPosition, timeSpent: saved ? saved.time_spent : addTime, lastReadAt: saved ? saved.last_read_at : Date.now() });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/contacts') {
      const body = await parseBody(req);
      if (body.__parseError) return sendJson(res, 400, { ok: false, msg: body.__parseError });
      const validationErrors = validateContactPayload(body);
      if (validationErrors.length) return sendJson(res, 400, { ok: false, msg: validationErrors[0] });
      const inserted = await insertContactMessage(body);
      if (!inserted) return sendJson(res, 500, { ok: false, msg: 'Could not save message.' });
      return sendJson(res, 200, { ok: true, msg: 'Message sent! We\'ll reply within 24 hours.' });
    }

    if (req.method === 'POST' && url.pathname === '/api/newsletter') {
      const body = await parseBody(req);
      if (body.__parseError) return sendJson(res, 400, { ok: false, msg: body.__parseError });
      const validationErrors = validateNewsletterPayload(body);
      if (validationErrors.length) return sendJson(res, 400, { ok: false, msg: validationErrors[0] });
      const email = String(body.email || '').trim().toLowerCase();
      const result = await insertNewsletterSignup(email);
      if (!result.ok) return sendJson(res, 200, { ok: true, msg: result.msg || 'You are already subscribed.' });
      return sendJson(res, 200, { ok: true, msg: 'You\'re on the list! 📚' });
    }

    if (url.pathname === '/api/promoted') {
      try {
        const { data, error } = await supabaseAdmin.from('book_titles').select('*').eq('promoted', true).eq('status', 'approved');
        if (error) return sendJson(res, 500, { ok: false, msg: 'Unable to fetch promoted books.' });
        return sendJson(res, 200, (data || []).map(row => sanitizeBook(row)));
      } catch (e) {
        return sendJson(res, 500, { ok: false, msg: 'Unable to fetch promoted books.' });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/trending') {
      const items = await getTrendingBooks();
      return sendJson(res, 200, items);
    }

    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { ok: false, msg: 'Login required.' });
      try {
        const { data: uploads } = await supabaseAdmin.from('book_titles').select('*').eq('uploader_id', user.id);
        const sanitizedUploads = (uploads || []).map(b => sanitizeBook(b));
        const uploadIds = (uploads || []).map(b => b.id);
        const { data: purchases } = await supabaseAdmin.from('book_purchases').select('amount,book_id').in('book_id', uploadIds);
        const earned = (purchases || []).reduce((sum, p) => sum + Number(p.amount || 0), 0);
        const { data: readEntries } = await supabaseAdmin.from('book_reading_progress').select('*').eq('user_id', user.id).gt('position', 0);
        const booksRead = new Set((readEntries || []).map(r => r.book_id)).size;
        const timeSpent = (readEntries || []).reduce((sum, r) => sum + Number(r.time_spent || 0), 0);
        const recentReads = (readEntries || []).slice().sort((a, b) => (b.last_read_at || 0) - (a.last_read_at || 0)).slice(0, 5).map(entry => ({ bookId: entry.book_id, title: entry.book_title || 'Unknown book', position: entry.position, timeSpent: entry.time_spent || 0, lastReadAt: entry.last_read_at || 0 }));
        return sendJson(res, 200, { ok: true, uploads: sanitizedUploads, stats: { uploadedCount: sanitizedUploads.length, earned: Number(earned.toFixed(2)), booksRead, timeSpent: Math.round(timeSpent), badges: user.badges || [] }, recentReads });
      } catch (err) {
        console.error('dashboard query failed', err);
        return sendJson(res, 500, { ok: false, msg: 'Unable to load dashboard.' });
      }
    }

    if (url.pathname.startsWith('/api/admin')) {
      const user = await authUser(req);
      if (!user || !isAdminUser(user)) return sendJson(res, 403, { ok: false, msg: 'Admin access required.' });

      const segments = url.pathname.split('/').filter(Boolean);
      const bookId = Number(segments[3]);

      if (req.method === 'GET' && url.pathname === '/api/admin/books/pending') {
        try {
          if (!supabaseAdmin) {
            const pending = localDb.book_titles.filter(b => b.status === 'pending');
            return sendJson(res, 200, pending.map(b => sanitizeBook(b)));
          }
          const { data, error } = await supabaseAdmin.from('book_titles').select('*').eq('status', 'pending').order('created_at', { ascending: true });
          if (error) {
            console.error('Supabase admin pending books error', error);
            return sendJson(res, 500, { ok: false, msg: 'Unable to load pending books.' });
          }
          return sendJson(res, 200, (data || []).map(b => sanitizeBook(b)));
        } catch (err) {
          console.error('admin pending books error', err);
          return sendJson(res, 500, { ok: false, msg: 'Unable to load pending books.' });
        }
      }

      if (req.method === 'POST' && segments[4] === 'approve' && !Number.isNaN(bookId)) {
        try {
          if (!supabaseAdmin) {
            const book = localDb.book_titles.find(b => Number(b.id) === bookId);
            if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
            book.status = 'approved';
            return sendJson(res, 200, { ok: true, msg: 'Book approved.', book: sanitizeBook(book) });
          }
          const { data, error } = await supabaseAdmin.from('book_titles').update({ status: 'approved' }).eq('id', bookId).select().maybeSingle();
          if (error) {
            console.error('Supabase admin approve error', error);
            return sendJson(res, 500, { ok: false, msg: 'Unable to approve book.' });
          }
          if (!data) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
          return sendJson(res, 200, { ok: true, msg: 'Book approved.', book: sanitizeBook(data) });
        } catch (err) {
          console.error('admin approve error', err);
          return sendJson(res, 500, { ok: false, msg: 'Unable to approve book.' });
        }
      }

      if (req.method === 'POST' && segments[4] === 'reject' && !Number.isNaN(bookId)) {
        try {
          if (!supabaseAdmin) {
            const book = localDb.book_titles.find(b => Number(b.id) === bookId);
            if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
            book.status = 'rejected';
            return sendJson(res, 200, { ok: true, msg: 'Book rejected.', book: sanitizeBook(book) });
          }
          const { data, error } = await supabaseAdmin.from('book_titles').update({ status: 'rejected' }).eq('id', bookId).select().maybeSingle();
          if (error) {
            console.error('Supabase admin reject error', error);
            return sendJson(res, 500, { ok: false, msg: 'Unable to reject book.' });
          }
          if (!data) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
          return sendJson(res, 200, { ok: true, msg: 'Book rejected.', book: sanitizeBook(data) });
        } catch (err) {
          console.error('admin reject error', err);
          return sendJson(res, 500, { ok: false, msg: 'Unable to reject book.' });
        }
      }

      return sendJson(res, 404, { ok: false, msg: 'Admin API endpoint not found.' });
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, status: 'ok' });
    }

    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, 404, { ok: false, msg: 'API endpoint not found.' });
    }

    serveStatic(req, res);
  });

  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (require.main === module) {
  startServer().then(() => console.log(`Wimpy Books server running on http://127.0.0.1:${PORT}`));
}

module.exports = { startServer };
