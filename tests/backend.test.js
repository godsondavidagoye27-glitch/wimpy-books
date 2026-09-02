const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../server');

// Enable dev-token authentication for tests
process.env.ALLOW_DEV_AUTH = 'true';

let server;
let baseUrl;

const token = 'dev-token';
const email = 'tester@example.com';

test.before(async () => {
  server = await startServer(3100);
  baseUrl = 'http://127.0.0.1:3100/api';
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

test('health and book listing work', async () => {
  const healthRes = await fetch(`${baseUrl}/health`);
  const healthBody = await healthRes.json();
  assert.equal(healthRes.status, 200);
  assert.equal(healthBody.ok, true);

  const booksRes = await fetch(`${baseUrl}/books`);
  const books = await booksRes.json();
  assert.equal(booksRes.status, 200);
  assert.ok(Array.isArray(books));
});

test('authenticated uploads and purchases work with WimpyID-style bearer tokens', async () => {
  const uploadRes = await fetch(`${baseUrl}/books`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      title: 'Wimpy Test Book',
      author: 'Tester',
      description: 'A test book for the new flow.',
      preview: 'Preview text',
      isFree: false,
      price: 2500,
      fileName: 'book.txt',
      fileType: 'text/plain',
      fileData: 'data:text/plain;base64,SGVsbG8sIFdvcmxkIQ=='
    })
  });
  const uploadBody = await uploadRes.json();
  assert.equal(uploadRes.status, 200);
  assert.equal(uploadBody.ok, true);

  const purchaseRes = await fetch(`${baseUrl}/books/${uploadBody.book.id}/purchase`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    }
  });
  const purchaseBody = await purchaseRes.json();
  assert.equal(purchaseRes.status, 200);
  assert.equal(purchaseBody.ok, true);

  const accessRes = await fetch(`${baseUrl}/books/${uploadBody.book.id}/access`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const accessBody = await accessRes.json();
  assert.equal(accessRes.status, 200);
  assert.equal(accessBody.ok, true);
  assert.equal(accessBody.canRead, true);
});

test('subscriptions grant access without per-book wallet charges', async () => {
  const subscriptionRes = await fetch(`${baseUrl}/subscriptions/unlimited`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    }
  });
  const subscriptionBody = await subscriptionRes.json();
  assert.equal(subscriptionRes.status, 200);
  assert.equal(subscriptionBody.ok, true);

  const bookRes = await fetch(`${baseUrl}/books`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      title: 'Unlimited Access Trial Book',
      author: 'Tester',
      description: 'A book unlocked by the unlimited subscription.',
      preview: 'Preview text',
      isFree: false,
      price: 1900,
      fileName: 'sub.txt',
      fileType: 'text/plain',
      fileData: 'data:text/plain;base64,SGVsbG8sIFdvcmxkIQ=='
    })
  });
  const bookBody = await bookRes.json();
  assert.equal(bookRes.status, 200);
  assert.equal(bookBody.ok, true);

  const accessRes = await fetch(`${baseUrl}/books/${bookBody.book.id}/access`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const accessBody = await accessRes.json();
  assert.equal(accessRes.status, 200);
  assert.equal(accessBody.ok, true);
  assert.equal(accessBody.canRead, true);
});

test('insufficient wallet balance is rejected without recording a purchase', async () => {
  const fakePayServer = http.createServer((req, res) => {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'insufficient-funds' }));
  });

  await new Promise(resolve => fakePayServer.listen(3111, '127.0.0.1', resolve));
  process.env.WIMPYPAY_API_URL = 'http://127.0.0.1:3111';
  process.env.WIMPYPAY_INTERNAL_API_KEY = 'shared-secret';

  try {
    const bookRes = await fetch(`${baseUrl}/books`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        title: 'Wimpy Balance Test',
        author: 'Tester',
        description: 'A book used to test insufficient funds.',
        preview: 'Preview text',
        isFree: false,
        price: 2500,
        fileName: 'balance.txt',
        fileType: 'text/plain',
        fileData: 'data:text/plain;base64,SGVsbG8sIFdvcmxkIQ=='
      })
    });
    const bookBody = await bookRes.json();
    assert.equal(bookRes.status, 200);

    const purchaseRes = await fetch(`${baseUrl}/books/${bookBody.book.id}/purchase`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });
    const purchaseBody = await purchaseRes.json();
    assert.equal(purchaseRes.status, 402);
    assert.equal(purchaseBody.ok, false);
    assert.match(purchaseBody.msg, /wallet doesn't have enough balance/i);
  } finally {
    await new Promise(resolve => fakePayServer.close(resolve));
    delete process.env.WIMPYPAY_API_URL;
    delete process.env.WIMPYPAY_INTERNAL_API_KEY;
  }
});
