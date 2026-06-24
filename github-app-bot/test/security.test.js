import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlResponse, scriptTag } from '../src/admin/security.js';
import { safeScriptJson } from '../src/admin/templates.js';

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
  assert.match(body, /<script>evil\(\);<\/script>/);
  assert.doesNotMatch(body, new RegExp(`<script nonce="${nonce}">evil`));
});

test('safeScriptJson escapes breakout sequences for inline <script> embedding', () => {
  const out = safeScriptJson({ a: 'x</script>y-->z&u' });
  // nothing that can break out of a <script> block remains in the output
  assert.equal(out.includes('</script>'), false, 'closing script tag escaped');
  assert.equal(out.includes('<'), false, '< escaped');
  assert.equal(out.includes('>'), false, '> escaped');
  assert.equal(out.includes('&'), false, '& escaped');
  // the escaped output is still valid JSON that round-trips to the original
  assert.deepEqual(JSON.parse(out), { a: 'x</script>y-->z&u' });
});
