import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlResponse, scriptTag } from '../src/admin/security.js';
import { safeScriptJson, renderErrorPage } from '../src/admin/templates.js';

test('htmlResponse stamps CSP script-src nonce matching scriptTag output', () => {
  const { headers, body } = htmlResponse((nonce) => `<main>${scriptTag('var x=1;', nonce)}</main>`);
  const csp = headers['content-security-policy'];
  const match = csp.match(/script-src 'nonce-([^']+)'/);
  assert.ok(match, 'CSP contains a script-src nonce');
  const nonce = match[1];
  assert.match(body, new RegExp(`<script nonce="${nonce}">var x=1;</script>`));
});

test('htmlResponse does not grant a nonce to a bare injected <script>', () => {
  const { headers, body } = htmlResponse((nonce) => `${scriptTag('ok();', nonce)}<script>evil();</script>`);
  const nonce = headers['content-security-policy'].match(/script-src 'nonce-([^']+)'/)[1];
  assert.match(body, new RegExp(`<script nonce="${nonce}">ok\\(\\);</script>`));
  assert.match(body, /<script>evil\(\);<\/script>/);
  assert.doesNotMatch(body, new RegExp(`<script nonce="${nonce}">evil`));
});

test('an injected script carrying a fixed marker string is NOT granted the nonce', () => {
  // The nonce is threaded explicitly at render time; there is no fixed marker
  // replaced on the final HTML, so a script containing a known/placeholder
  // nonce value must NOT pick up the response nonce (CSP stays a real backstop
  // and legitimate content containing the string is never rewritten).
  const { headers, body } = htmlResponse((nonce) => `${scriptTag('ok();', nonce)}<script nonce="__ocr_csp_nonce__">evil();</script>`);
  const nonce = headers['content-security-policy'].match(/script-src 'nonce-([^']+)'/)[1];
  assert.notEqual(nonce, '__ocr_csp_nonce__');
  assert.match(body, /<script nonce="__ocr_csp_nonce__">evil\(\);<\/script>/);
  assert.doesNotMatch(body, new RegExp(`<script nonce="${nonce}">evil`));
});

test('safeScriptJson escapes breakout sequences for inline <script> embedding', () => {
  const out = safeScriptJson({ a: 'x</script>y-->z&u' });
  assert.equal(out.includes('</script>'), false, 'closing script tag escaped');
  assert.equal(out.includes('<'), false, '< escaped');
  assert.equal(out.includes('>'), false, '> escaped');
  assert.equal(out.includes('&'), false, '& escaped');
  assert.deepEqual(JSON.parse(out), { a: 'x</script>y-->z&u' });
});

test('renderErrorPage authenticated branch threads cspNonce into its scripts', () => {
  const html = renderErrorPage({ csrfToken: 'x', cspNonce: 'ABC123', title: 'Error', message: 'boom' });
  assert.match(html, /<script nonce="ABC123">/);
});
