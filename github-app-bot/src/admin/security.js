import crypto from 'node:crypto';

export function scriptTag(js, nonce) {
  return `<script nonce="${nonce}">${js}</script>`;
}

const DEFAULT_SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'same-origin',
  'permissions-policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex, nofollow',
});

export function securityHeaders({ contentType = 'text/html; charset=utf-8', cache = 'no-store', scriptNonce = '' } = {}) {
  const headers = { ...DEFAULT_SECURITY_HEADERS };
  if (scriptNonce) headers['content-security-policy'] = `${headers['content-security-policy']}; script-src 'nonce-${scriptNonce}'`;
  if (contentType) headers['content-type'] = contentType;
  if (cache) headers['cache-control'] = cache;
  return headers;
}

export function mergeHeaders(...headerSets) {
  const merged = {};
  for (const headers of headerSets) {
    if (!headers || typeof headers !== 'object') continue;
    for (const [key, value] of Object.entries(headers)) {
      if (value == null) continue;
      merged[key.toLowerCase()] = value;
    }
  }
  return merged;
}

export function redirect(location, { status = 303, headers = {} } = {}) {
  if (typeof location !== 'string' || !location.startsWith('/admin/')) {
    throw new Error('Admin redirects must stay under /admin/');
  }
  return {
    status,
    headers: mergeHeaders(securityHeaders({ contentType: '' }), headers, { location }),
    body: '',
  };
}

export function htmlResponse(bodyOrRender, { status = 200, headers = {} } = {}) {
  let body;
  let scriptNonce = '';
  if (typeof bodyOrRender === 'function') {
    scriptNonce = crypto.randomBytes(18).toString('base64url');
    body = bodyOrRender(scriptNonce);
    if (typeof body !== 'string') throw new Error('HTML render callback must return a string');
  } else {
    if (typeof bodyOrRender !== 'string') throw new Error('HTML response body must be a string');
    body = bodyOrRender;
  }
  return {
    status,
    headers: mergeHeaders(securityHeaders({ scriptNonce }), headers),
    body,
  };
}

export function textResponse(body, { status = 200, headers = {} } = {}) {
  if (typeof body !== 'string') throw new Error('Text response body must be a string');
  return {
    status,
    headers: mergeHeaders(securityHeaders({ contentType: 'text/plain; charset=utf-8' }), headers),
    body,
  };
}

export function notFound() {
  return textResponse('Not found', { status: 404 });
}

export function methodNotAllowed(allowedMethods) {
  if (!Array.isArray(allowedMethods) || allowedMethods.length === 0) throw new Error('allowedMethods must be a non-empty array');
  return textResponse('Method not allowed', {
    status: 405,
    headers: { allow: allowedMethods.join(', ') },
  });
}

export function forbidden(message = 'Forbidden') {
  return textResponse(message, { status: 403 });
}

export function unauthorized(message = 'Unauthorized') {
  return textResponse(message, { status: 401 });
}
