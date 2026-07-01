const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('../server');

let server;
let baseUrl;

const dataFile = path.join(__dirname, '..', 'data.json');

test.before(async () => {
  if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
  server = await startServer(3100);
  baseUrl = 'http://127.0.0.1:3100/api';
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

test('stripe webhook endpoint rejects unsigned requests', async () => {
  const webhookRes = await fetch(`${baseUrl}/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'checkout.session.completed' })
  });
  const webhookBody = await webhookRes.json();
  assert.equal(webhookRes.status, 400);
  assert.equal(webhookBody.ok, false);
});

test('signup and login work and books can be purchased', async () => {
  const email = `tester-${Date.now()}@example.com`;
  const signupRes = await fetch(`${baseUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Tester', email, password: 'secret123' })
  });
  const signupBody = await signupRes.json();
  assert.equal(signupRes.status, 200);
  assert.equal(signupBody.ok, true);

  const loginRes = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  });
  const loginBody = await loginRes.json();
  assert.equal(loginRes.status, 200);
  assert.equal(loginBody.ok, true);

  const bookRes = await fetch(`${baseUrl}/books`);
  const books = await bookRes.json();
  const paidBook = books.find(book => !book.isFree);
  assert.ok(paidBook);

  const purchaseRes = await fetch(`${baseUrl}/books/${paidBook.id}/purchase`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${loginBody.user.token}`
    }
  });
  const purchaseBody = await purchaseRes.json();
  assert.equal(purchaseRes.status, 200);
  assert.equal(purchaseBody.ok, true);
});

test('rejects unsupported or oversized uploads', async () => {
  const email = `invalid-${Date.now()}@example.com`;
  const signupRes = await fetch(`${baseUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Invalid', email, password: 'secret123' })
  });
  const signupBody = await signupRes.json();
  assert.equal(signupRes.status, 200);
  assert.equal(signupBody.ok, true);

  const uploadRes = await fetch(`${baseUrl}/books`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signupBody.user.token}`
    },
    body: JSON.stringify({
      title: 'Bad Upload',
      author: 'Bad Author',
      description: 'This should be rejected.',
      preview: 'Preview text',
      isFree: true,
      price: 0,
      fileName: 'notes.docx',
      fileType: 'application/msword',
      fileData: 'data:application/msword;base64,SGVsbG8sIFdvcmxkIQ=='
    })
  });
  const uploadBody = await uploadRes.json();
  assert.equal(uploadRes.status, 400);
  assert.equal(uploadBody.ok, false);
});

test('dashboard, upload access, and progress endpoints work', async () => {
  const email = `dashboard-${Date.now()}@example.com`;
  const signupRes = await fetch(`${baseUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Dash', email, password: 'secret123' })
  });
  const signupBody = await signupRes.json();
  assert.equal(signupRes.status, 200);
  assert.equal(signupBody.ok, true);

  const uploadRes = await fetch(`${baseUrl}/books`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signupBody.user.token}`
    },
    body: JSON.stringify({
      title: 'Dashboard Book',
      author: 'Dash Author',
      description: 'A test upload for dashboard progress.',
      cover: 'linear-gradient(135deg,#123456,#654321)',
      preview: 'Preview text',
      isFree: true,
      price: 0,
      fileName: 'book.txt',
      fileType: 'text/plain',
      fileData: 'data:text/plain;base64,SGVsbG8sIFdvcmxkIQ=='
    })
  });
  const uploadBody = await uploadRes.json();
  assert.equal(uploadRes.status, 200);
  assert.equal(uploadBody.ok, true);

  const dashboardRes = await fetch(`${baseUrl}/dashboard`, {
    headers: { Authorization: `Bearer ${signupBody.user.token}` }
  });
  const dashboardBody = await dashboardRes.json();
  assert.equal(dashboardRes.status, 200);
  assert.equal(dashboardBody.ok, true);
  assert.ok(dashboardBody.uploads.some(book => book.title === 'Dashboard Book'));

  const accessRes = await fetch(`${baseUrl}/books/${uploadBody.book.id}/access`, {
    headers: { Authorization: `Bearer ${signupBody.user.token}` }
  });
  const accessBody = await accessRes.json();
  assert.equal(accessRes.status, 200);
  assert.equal(accessBody.ok, true);
  assert.equal(accessBody.canRead, true);

  const progressRes = await fetch(`${baseUrl}/books/${uploadBody.book.id}/progress`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signupBody.user.token}`
    },
    body: JSON.stringify({ position: 320 })
  });
  const progressBody = await progressRes.json();
  assert.equal(progressRes.status, 200);
  assert.equal(progressBody.ok, true);
  assert.equal(progressBody.position, 320);
});

test('contact and newsletter endpoints accept submissions', async () => {
  const contactRes = await fetch(`${baseUrl}/contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Ava', email: 'ava@example.com', subject: 'Hello', message: 'Testing contact flow.' })
  });
  const contactBody = await contactRes.json();
  assert.equal(contactRes.status, 200);
  assert.equal(contactBody.ok, true);

  const newsletterRes = await fetch(`${baseUrl}/newsletter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ava@example.com' })
  });
  const newsletterBody = await newsletterRes.json();
  assert.equal(newsletterRes.status, 200);
  assert.equal(newsletterBody.ok, true);
});

test('auth sync endpoint returns a valid dashboard token', async () => {
  const email = `sync-${Date.now()}@example.com`;
  const signupRes = await fetch(`${baseUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Sync User', email, password: 'secret123' })
  });
  const signupBody = await signupRes.json();
  assert.equal(signupRes.status, 200);
  assert.equal(signupBody.ok, true);

  const syncRes = await fetch(`${baseUrl}/auth/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name: 'Sync User', provider: 'supabase' })
  });
  const syncBody = await syncRes.json();
  assert.equal(syncRes.status, 200);
  assert.equal(syncBody.ok, true);
  assert.ok(syncBody.user?.token);

  const dashboardRes = await fetch(`${baseUrl}/dashboard`, {
    headers: { Authorization: `Bearer ${syncBody.user.token}` }
  });
  const dashboardBody = await dashboardRes.json();
  assert.equal(dashboardRes.status, 200);
  assert.equal(dashboardBody.ok, true);
});

test('book metadata and file endpoints work', async () => {
  const email = `reader-${Date.now()}@example.com`;
  const signupRes = await fetch(`${baseUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Reader', email, password: 'secret123' })
  });
  const signupBody = await signupRes.json();
  assert.equal(signupRes.status, 200);
  assert.equal(signupBody.ok, true);

  const uploadRes = await fetch(`${baseUrl}/books`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signupBody.user.token}`
    },
    body: JSON.stringify({
      title: 'Reader Test Book',
      author: 'Reader Author',
      description: 'A test upload for metadata and file routes.',
      preview: 'Preview text',
      isFree: true,
      price: 0,
      fileName: 'story.txt',
      fileType: 'text/plain',
      fileData: 'data:text/plain;base64,SGVsbG8sIFdvcmxkIQ=='
    })
  });
  const uploadBody = await uploadRes.json();
  assert.equal(uploadRes.status, 200);
  assert.equal(uploadBody.ok, true);

  const metadataRes = await fetch(`${baseUrl}/books/${uploadBody.book.id}`);
  const metadataBody = await metadataRes.json();
  assert.equal(metadataRes.status, 200);
  assert.equal(metadataBody.id, uploadBody.book.id);
  assert.equal(metadataBody.fileData, undefined);

  const fileRes = await fetch(`${baseUrl}/books/${uploadBody.book.id}/file`, {
    headers: { Authorization: `Bearer ${signupBody.user.token}` }
  });
  const fileBody = await fileRes.text();
  assert.equal(fileRes.status, 200);
  assert.equal(fileBody, 'Hello, World!');
});

test('book list returns uploaded cover image data', async () => {
  const email = `cover-${Date.now()}@example.com`;
  const signupRes = await fetch(`${baseUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Cover Tester', email, password: 'secret123' })
  });
  const signupBody = await signupRes.json();
  assert.equal(signupRes.status, 200);
  assert.equal(signupBody.ok, true);

  const uploadRes = await fetch(`${baseUrl}/books`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signupBody.user.token}`
    },
    body: JSON.stringify({
      title: 'Cover Test Book',
      author: 'Cover Author',
      description: 'A book with cover data.',
      preview: 'Preview text',
      isFree: true,
      price: 0,
      fileName: 'cover.txt',
      fileType: 'text/plain',
      fileData: 'data:text/plain;base64,SGVsbG8sIENvdmVyIQ==',
      coverImageData: 'data:image/png;base64,iVBORw0KGgo='
    })
  });
  const uploadBody = await uploadRes.json();
  assert.equal(uploadRes.status, 200);
  assert.equal(uploadBody.ok, true);

  const listRes = await fetch(`${baseUrl}/books`);
  const listBody = await listRes.json();
  const listed = listBody.find(book => book.id === uploadBody.book.id);
  assert.ok(listed);
  assert.equal(listed.coverImageData, 'data:image/png;base64,iVBORw0KGgo=');
});

test('trending endpoint ranks books by traffic and reads', async () => {
  const email = `trending-${Date.now()}@example.com`;
  const signupRes = await fetch(`${baseUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Trend', email, password: 'secret123' })
  });
  const signupBody = await signupRes.json();
  assert.equal(signupRes.status, 200);
  assert.equal(signupBody.ok, true);

  const uploadRes = await fetch(`${baseUrl}/books`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signupBody.user.token}`
    },
    body: JSON.stringify({
      title: 'Trending Book',
      author: 'Trend Author',
      description: 'A test upload for trending analytics.',
      preview: 'Preview text',
      isFree: true,
      price: 0,
      fileName: 'trend.txt',
      fileType: 'text/plain',
      fileData: 'data:text/plain;base64,SGVsbG8sIFdvcmxkIQ=='
    })
  });
  const uploadBody = await uploadRes.json();
  assert.equal(uploadRes.status, 200);
  assert.equal(uploadBody.ok, true);

  await fetch(`${baseUrl}/books/${uploadBody.book.id}`);
  await fetch(`${baseUrl}/books/${uploadBody.book.id}`, { headers: { Authorization: `Bearer ${signupBody.user.token}` } });
  await fetch(`${baseUrl}/books/${uploadBody.book.id}/progress`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signupBody.user.token}`
    },
    body: JSON.stringify({ position: 250 })
  });

  const trendingRes = await fetch(`${baseUrl}/trending`);
  const trendingBody = await trendingRes.json();
  assert.equal(trendingRes.status, 200);
  assert.equal(Array.isArray(trendingBody), true);
  const uploadedBook = trendingBody.find(book => book.id === uploadBody.book.id);
  assert.ok(uploadedBook);
  assert.ok(uploadedBook.traffic >= 0);
  assert.ok(uploadedBook.reads >= 0);
});
