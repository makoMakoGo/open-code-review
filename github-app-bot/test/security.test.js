import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlResponse, scriptTag } from '../src/admin/security.js';

test('htmlResponse stamps CSP script-src nonce matching scriptTag output', () => {
  const { headers, body } = htmlResponse(`<main>${scriptTag('var x=1;')}</main>`);
  const csp = headers['content-security-policy'];
  const match = csp.match(/script-src 'nonce-([^']+)'/);
  assert.ok(match, 'CSP contains a script-src nonce');
  const nonce = match[1];
  assert.match(body, new RegExp(`<script nonce="${nonce}">var x=1;</script>`));
});

test('htmlResponse does not grant a nonce to a bare injected <script>', () => {
  // A bare <script> not produced by scriptTag() must NOT receive the nonce, so
  // CSP still blocks it (defense-in-depth against content injection).
  const { headers, body } = htmlResponse(`${scriptTag('ok();')}<script>evil();</script>`);
  const nonce = headers['content-security-policy'].match(/script-src 'nonce-([^']+)'/)[1];
  assert.match(body, new RegExp(`<script nonce="${nonce}">ok\\(\\);</script>`));
  // the bare injected script is untouched (no nonce attribute added) -> would be CSP-blocked
  assert.match(body, /<script>evil\(\);<\/script>/);
  assert.doesNotMatch(body, new RegExp(`<script nonce="${nonce}">evil`));
});
