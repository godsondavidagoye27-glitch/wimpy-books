const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Stripe = require('stripe');

const PORT = process.env.PORT || 3000;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');

function readData() {
  if (!fs.existsSync(DATA_FILE)) {
    const seedData = {
      users: [],
      books: [
        {
          id: 1,
          title: 'The Silent Patient',
          author: 'Alex Michaelides',
          genre: 'thriller',
          description: 'A gripping psychological thriller with a mysterious silence.',
          cover: 'linear-gradient(135deg,#667eea,#764ba2)',
          preview: 'Alicia Berenson lives in silence after a shocking act of violence. Her therapist is determined to uncover the truth before the mystery consumes them both.',
          isFree: true,
          price: 0,
          rating: 4.8,
          ratings: 2340,
          comments: [{ user: 'Ada', text: 'A brilliant mystery that keeps you guessing.' }],
          promoted: true,
          premiumUploader: true,
          traffic: 124,
          reads: 81,
          uploader: 'demo@example.com',
          uploadedAt: new Date().toISOString()
        },
        {
          id: 2,
          title: 'Atomic Habits',
          author: 'James Clear',
          genre: 'self-help',
          description: 'Transform your habits and your life.',
          cover: 'linear-gradient(135deg,#f093fb,#f5576c)',
          preview: 'Tiny changes can compound over time into remarkable outcomes. Discover how to build systems that make the good habits easy and the bad habits difficult.',
          isFree: false,
          price: 9.99,
          rating: 4.7,
          ratings: 1180,
          comments: [{ user: 'Mina', text: 'Practical and motivating.' }],
          promoted: true,
          premiumUploader: true,
          traffic: 188,
          reads: 147,
          uploader: 'demo@example.com',
          uploadedAt: new Date().toISOString()
        }
      ],
      purchases: [],
      promotions: [],
      contacts: [],
      newsletter: []
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(seedData, null, 2));
    return seedData;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

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
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function parseRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sanitizeBook(book, includeFileData = false) {
  const sanitized = { ...book };
  if (!includeFileData) {
    delete sanitized.fileData;
  }
  return sanitized;
}

function getTrendingBooks(data) {
  const books = (data.books || []).map(book => {
    const traffic = Number(book.traffic || 0);
    const reads = Number(book.reads || 0);
    const progressEntries = (data.readingProgress || []).filter(entry => entry.bookId === book.id);
    const progressReads = progressEntries.length;
    const rankScore = traffic * 3 + reads * 4 + progressReads * 2;
    return { ...book, rankScore, progressReads };
  });

  return books
    .sort((a, b) => b.rankScore - a.rankScore || b.rating - a.rating || new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0))
    .slice(0, 8)
    .map(book => sanitizeBook(book));
}

function getBookFilePayload(book) {
  if (!book.fileData) {
    return { buffer: Buffer.alloc(0), contentType: 'application/octet-stream' };
  }

  const [header, body = ''] = String(book.fileData).split(',');
  const contentType = header.match(/data:([^;]+);/)?.[1] || 'application/octet-stream';
  const isBase64 = header.includes('base64');
  const payload = isBase64 ? body : decodeURIComponent(body);
  const buffer = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(payload);
  return { buffer, contentType };
}

function authUser(req) {
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '').trim();
  const data = readData();
  const user = data.users.find(entry => entry.token === token);
  return user || null;
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

function startServer(port = PORT) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (url.pathname.startsWith('/api/auth/')) {
      const data = readData();
      if (req.method === 'POST' && url.pathname === '/api/auth/signup') {
        const body = await parseBody(req);
        const email = body.email?.trim().toLowerCase();
        const name = body.name?.trim();
        const password = body.password;
        if (!name || !email || !password) return sendJson(res, 400, { ok: false, msg: 'All fields are required.' });
        if (data.users.find(user => user.email === email)) return sendJson(res, 400, { ok: false, msg: 'Email already exists.' });
        const user = {
          id: Date.now(),
          name,
          email,
          password: crypto.createHash('sha256').update(password).digest('hex'),
          token: crypto.randomBytes(16).toString('hex'),
          badges: ['New Reader']
        };
        data.users.push(user);
        writeData(data);
        return sendJson(res, 200, { ok: true, msg: 'Account created.', user: { id: user.id, name: user.name, email: user.email, token: user.token } });
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await parseBody(req);
        const email = body.email?.trim().toLowerCase();
        const password = body.password;
        const user = data.users.find(entry => entry.email === email);
        if (!user) return sendJson(res, 401, { ok: false, msg: 'No account found.' });
        const hashed = crypto.createHash('sha256').update(password).digest('hex');
        if (user.password !== hashed) return sendJson(res, 401, { ok: false, msg: 'Incorrect password.' });
        user.token = crypto.randomBytes(16).toString('hex');
        writeData(data);
        return sendJson(res, 200, { ok: true, msg: `Welcome back, ${user.name}!`, user: { id: user.id, name: user.name, email: user.email, token: user.token, badges: user.badges } });
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/sync') {
        const body = await parseBody(req);
        const email = body.email?.trim().toLowerCase();
        const name = body.name?.trim();
        if (!email) return sendJson(res, 400, { ok: false, msg: 'Email is required.' });
        let user = data.users.find(entry => entry.email === email);
        if (!user) {
          user = {
            id: Date.now(),
            name: name || 'Reader',
            email,
            password: crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex'),
            token: crypto.randomBytes(16).toString('hex'),
            badges: ['Supabase Reader']
          };
          data.users.push(user);
        } else {
          user.name = name || user.name;
          user.token = crypto.randomBytes(16).toString('hex');
          user.badges = user.badges || ['Reader'];
        }
        writeData(data);
        return sendJson(res, 200, { ok: true, user: { id: user.id, name: user.name, email: user.email, token: user.token, badges: user.badges } });
      }
    }

    if (url.pathname.startsWith('/api/books')) {
      const data = readData();
      const segments = url.pathname.split('/').filter(Boolean);
      const bookId = Number(segments[2]);
      if (req.method === 'GET' && url.pathname === '/api/books') {
        return sendJson(res, 200, data.books.map(book => sanitizeBook(book)));
      }
      if (req.method === 'GET' && !Number.isNaN(bookId) && segments.length === 3) {
        const book = data.books.find(entry => entry.id === bookId);
        if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
        book.traffic = Number(book.traffic || 0) + 1;
        writeData(data);
        return sendJson(res, 200, sanitizeBook(book));
      }
      if (req.method === 'GET' && !Number.isNaN(bookId) && segments[3] === 'file') {
        const book = data.books.find(entry => entry.id === bookId);
        if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
        const user = authUser(req);
        const ownsBook = user ? data.purchases.some(entry => entry.userId === user.id && entry.bookId === book.id) : false;
        const canRead = book.isFree || ownsBook;
        if (!canRead) {
          return sendJson(res, user ? 403 : 401, { ok: false, msg: user ? 'Access denied.' : 'Login required.' });
        }
        book.traffic = Number(book.traffic || 0) + 1;
        writeData(data);
        const { buffer, contentType } = getBookFilePayload(book);
        if (!buffer || buffer.length === 0) {
          return sendJson(res, 404, { ok: false, msg: 'No file content available.' });
        }
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': buffer.length,
          'Content-Disposition': `inline; filename="${book.fileName || 'book'}"`
        });
        return res.end(buffer);
      }
      if (req.method === 'POST' && url.pathname === '/api/books') {
        const body = await parseBody(req);
        const user = authUser(req);
        if (!user) return sendJson(res, 401, { ok: false, msg: 'Login required.' });
        const validationErrors = validateBookPayload(body);
        if (validationErrors.length) return sendJson(res, 400, { ok: false, msg: validationErrors[0] });
        const book = {
          id: Date.now(),
          title: body.title,
          author: body.author,
          genre: body.genre,
          description: body.description,
          cover: body.cover || 'linear-gradient(135deg,#667eea,#764ba2)',
          coverImageData: body.coverImageData || null,
          preview: body.preview || body.description,
          isFree: body.isFree !== false,
          price: Number(body.price || 0),
          fileName: body.fileName || null,
          fileType: body.fileType || null,
          fileData: body.fileData || null,
          rating: 0,
          ratings: 0,
          comments: [],
          promoted: Boolean(body.promoted || body.premiumUploader),
          premiumUploader: body.premiumUploader !== false,
          traffic: Number(body.traffic || 0),
          reads: Number(body.reads || 0),
          uploader: user.email,
          uploadedAt: new Date().toISOString()
        };
        data.books.unshift(book);
        writeData(data);
        return sendJson(res, 200, { ok: true, book: sanitizeBook(book) });
      }
      if (req.method === 'POST' && segments[3] === 'purchase' && !Number.isNaN(bookId)) {
        const user = authUser(req);
        if (!user) return sendJson(res, 401, { ok: false, msg: 'Login required.' });
        const book = data.books.find(entry => entry.id === bookId);
        if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
        if (book.isFree) return sendJson(res, 200, { ok: true, msg: 'Free book unlocked.', book });
        const alreadyPurchased = data.purchases.some(entry => entry.userId === user.id && entry.bookId === book.id);
        if (alreadyPurchased) return sendJson(res, 200, { ok: true, msg: 'You already own this book.', book });
        data.purchases.push({ userId: user.id, bookId: book.id, amount: book.price });
        data.books = data.books.map(entry => entry.id === book.id ? { ...entry, sales: (entry.sales || 0) + 1 } : entry);
        writeData(data);
        return sendJson(res, 200, { ok: true, msg: 'Purchase successful.', book });
      }
      if (req.method === 'POST' && segments[3] === 'comment' && !Number.isNaN(bookId)) {
        const user = authUser(req);
        if (!user) return sendJson(res, 401, { ok: false, msg: 'Login required.' });
        const body = await parseBody(req);
        const book = data.books.find(entry => entry.id === bookId);
        if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
        book.comments.push({ user: user.name, text: body.text });
        writeData(data);
        return sendJson(res, 200, { ok: true, comments: book.comments });
      }
      if (req.method === 'POST' && segments[3] === 'rate' && !Number.isNaN(bookId)) {
        const user = authUser(req);
        if (!user) return sendJson(res, 401, { ok: false, msg: 'Login required.' });
        const body = await parseBody(req);
        const book = data.books.find(entry => entry.id === bookId);
        if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
        const score = Number(body.score || 0);
        book.rating = ((book.rating * book.ratings) + score) / (book.ratings + 1);
        book.ratings += 1;
        writeData(data);
        return sendJson(res, 200, { ok: true, rating: book.rating, ratings: book.ratings });
      }
      if (req.method === 'DELETE' && !Number.isNaN(bookId)) {
        const user = authUser(req);
        if (!user) return sendJson(res, 401, { ok: false, msg: 'Login required.' });
        const book = data.books.find(entry => entry.id === bookId);
        if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
        if (book.uploader !== user.email) return sendJson(res, 403, { ok: false, msg: 'Only the uploader can remove this book.' });
        data.books = data.books.filter(entry => entry.id !== bookId);
        data.purchases = data.purchases.filter(purchase => purchase.bookId !== bookId);
        writeData(data);
        return sendJson(res, 200, { ok: true, msg: 'Book deleted.' });
      }
      if (req.method === 'GET' && segments[3] === 'access' && !Number.isNaN(bookId)) {
        const user = authUser(req);
        const book = data.books.find(entry => entry.id === bookId);
        if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
        const ownsBook = user ? data.purchases.some(entry => entry.userId === user.id && entry.bookId === book.id) : false;
        const canRead = book.isFree || ownsBook;
        if (!canRead && !user) {
          return sendJson(res, 401, { ok: false, msg: 'Login required to access paid books.' });
        }
        return sendJson(res, 200, { ok: true, canRead, isFree: book.isFree, owned: ownsBook });
      }
      if (req.method === 'GET' && segments[3] === 'progress' && !Number.isNaN(bookId)) {
        const user = authUser(req);
        if (!user) return sendJson(res, 401, { ok: false, msg: 'Login required.' });
        const book = data.books.find(entry => entry.id === bookId);
        if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
        const progress = (data.readingProgress || []).find(entry => entry.userId === user.id && entry.bookId === book.id);
        return sendJson(res, 200, { ok: true, position: progress ? progress.position : 0, timeSpent: progress ? progress.timeSpent || 0 : 0 });
      }
      if (req.method === 'POST' && segments[3] === 'progress' && !Number.isNaN(bookId)) {
        const user = authUser(req);
        if (!user) return sendJson(res, 401, { ok: false, msg: 'Login required.' });
        const body = await parseBody(req);
        const book = data.books.find(entry => entry.id === bookId);
        if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
        const progressList = data.readingProgress || [];
        const existing = progressList.find(entry => entry.userId === user.id && entry.bookId === book.id);
        const newPosition = Number(body.position || 0);
        const addTime = Number(body.timeSpent || 0);
        const now = Date.now();
        if (existing) {
          existing.position = newPosition;
          existing.timeSpent = (existing.timeSpent || 0) + addTime;
          existing.lastReadAt = now;
        } else {
          progressList.push({ userId: user.id, bookId: book.id, position: newPosition, timeSpent: addTime, lastReadAt: now });
        }
        data.readingProgress = progressList;
        book.reads = Number(book.reads || 0) + 1;
        book.traffic = Number(book.traffic || 0) + 1;
        writeData(data);
        const saved = progressList.find(entry => entry.userId === user.id && entry.bookId === book.id);
        return sendJson(res, 200, { ok: true, position: newPosition, timeSpent: saved.timeSpent, lastReadAt: saved.lastReadAt });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/contacts') {
      const body = await parseBody(req);
      const data = readData();
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim();
      const subject = String(body.subject || '').trim();
      const message = String(body.message || '').trim();
      if (!name || !email || !message) {
        return sendJson(res, 400, { ok: false, msg: 'Please fill in your name, email, and message.' });
      }
      data.contacts.push({ id: Date.now(), name, email, subject, message, createdAt: new Date().toISOString() });
      writeData(data);
      return sendJson(res, 200, { ok: true, msg: 'Message sent! We\'ll reply within 24 hours.' });
    }

    if (req.method === 'POST' && url.pathname === '/api/newsletter') {
      const body = await parseBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) {
        return sendJson(res, 400, { ok: false, msg: 'Please enter a valid email.' });
      }
      const data = readData();
      const alreadySubscribed = data.newsletter.some(entry => entry.email === email);
      if (!alreadySubscribed) {
        data.newsletter.push({ id: Date.now(), email, createdAt: new Date().toISOString() });
        writeData(data);
      }
      return sendJson(res, 200, { ok: true, msg: 'You\'re on the list! 📚' });
    }

    if (req.method === 'POST' && url.pathname === '/api/checkout/create-session') {
      const user = authUser(req);
      if (!user) return sendJson(res, 401, { ok: false, msg: 'Login required.' });
      const body = await parseBody(req);
      const data = readData();
      const book = data.books.find(entry => entry.id === Number(body.bookId));
      if (!book) return sendJson(res, 404, { ok: false, msg: 'Book not found.' });
      if (!stripe) return sendJson(res, 200, { ok: false, msg: 'Stripe is not configured yet. Set STRIPE_SECRET_KEY to enable real payments.' });

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: user.email,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(Number(book.price || 0) * 100),
            product_data: { name: book.title, description: book.description }
          }
        }],
        metadata: { bookId: String(book.id), userEmail: user.email },
        success_url: `${body.successUrl || 'http://127.0.0.1:3000/display.html?id=' + book.id}&checkout=success`,
        cancel_url: `${body.cancelUrl || 'http://127.0.0.1:3000/display.html?id=' + book.id}&checkout=cancelled`
      });

      return sendJson(res, 200, { ok: true, url: session.url, sessionId: session.id });
    }

    if (req.method === 'POST' && url.pathname === '/api/stripe/webhook') {
      const signature = req.headers['stripe-signature'];
      const rawBody = await parseRawBody(req);
      if (!signature || !stripe) {
        return sendJson(res, 400, { ok: false, msg: 'Missing signature or Stripe not configured.' });
      }

      let event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test');
      } catch (error) {
        return sendJson(res, 400, { ok: false, msg: 'Webhook signature verification failed.' });
      }

      if (event.type === 'checkout.session.completed') {
        const data = readData();
        const session = event.data.object;
        const bookId = Number(session.metadata?.bookId);
        const userEmail = session.metadata?.userEmail || session.customer_email;
        const book = data.books.find(entry => entry.id === bookId);
        if (book) {
          data.purchases.push({ userId: userEmail, bookId: book.id, amount: book.price, source: 'stripe' });
          data.books = data.books.map(entry => entry.id === book.id ? { ...entry, sales: (entry.sales || 0) + 1 } : entry);
          writeData(data);
        }
      }

      return sendJson(res, 200, { ok: true, received: true });
    }

    if (url.pathname === '/api/promoted') {
      const data = readData();
      return sendJson(res, 200, data.books.filter(book => book.promoted).map(book => sanitizeBook(book)));
    }

    if (req.method === 'GET' && url.pathname === '/api/trending') {
      const data = readData();
      return sendJson(res, 200, getTrendingBooks(data));
    }

    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      const user = authUser(req);
      if (!user) return sendJson(res, 401, { ok: false, msg: 'Login required.' });
      const data = readData();
      const uploads = data.books.filter(book => book.uploader === user.email).map(book => sanitizeBook(book));
      const uploadIds = uploads.map(book => book.id);
      const earned = (data.purchases || [])
        .filter(purchase => uploadIds.includes(purchase.bookId))
        .reduce((sum, purchase) => sum + Number(purchase.amount || 0), 0);
      const readEntries = (data.readingProgress || []).filter(entry => entry.userId === user.id && Number(entry.position) > 0);
      const booksRead = new Set(readEntries.map(entry => entry.bookId)).size;
      const timeSpent = readEntries.reduce((sum, entry) => sum + Number(entry.timeSpent || 0), 0);
      const recentReads = readEntries
        .slice()
        .sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0))
        .slice(0, 5)
        .map(entry => {
          const book = data.books.find(b => b.id === entry.bookId);
          return {
            bookId: entry.bookId,
            title: book ? book.title : 'Unknown book',
            position: entry.position,
            timeSpent: entry.timeSpent || 0,
            lastReadAt: entry.lastReadAt || 0
          };
        });
      return sendJson(res, 200, {
        ok: true,
        uploads,
        stats: {
          uploadedCount: uploads.length,
          earned: Number(earned.toFixed(2)),
          booksRead,
          timeSpent: Math.round(timeSpent),
          badges: user.badges || []
        },
        recentReads
      });
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