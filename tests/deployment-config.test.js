'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('Vercel ignore config excludes private PDF and inactive review artifacts', () => {
  const ignore = fs.readFileSync(path.join(root, '.vercelignore'), 'utf8');
  const productPage = fs.readFileSync(path.join(root, 'technique.html'), 'utf8');
  assert.match(ignore, /^output\/pdf\//m);
  assert.match(ignore, /^integration-review\//m);
  assert.match(ignore, /^tmp\//m);
  assert.doesNotMatch(productPage, /output\/pdf/);
  assert.equal(fs.existsSync(path.join(root, 'output', 'pdf')), false);
});

test('production payment handler stays closed until a separate launch change', () => {
  const source = fs.readFileSync(path.join(root, 'api', 'create-payment.js'), 'utf8');
  assert.match(source, /VERCEL_ENV === 'production'[\s\S]*?status\(503\)/);
});
