import { isIP } from 'node:net';

const DEFAULT_ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function normalizeHostHeader(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.trim() === '') return null;
  const raw = hostHeader.trim();
  if (raw.length > 255 || /[\r\n]/.test(raw)) return null;

  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end === -1) return null;
    const host = raw.slice(1, end).toLowerCase();
    const portPart = raw.slice(end + 1);
    if (portPart !== '' && !isValidPortPart(portPart)) return null;
    return isValidHostName(host) ? host : null;
  }

  const colonCount = (raw.match(/:/g) ?? []).length;
  if (colonCount > 1) {
    const host = raw.toLowerCase();
    return isValidHostName(host) ? host : null;
  }

  const [host, portPart = ''] = raw.split(':');
  if (portPart !== '' && !isValidPort(portPart)) return null;
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return isValidHostName(normalized) ? normalized : null;
}

export function parseAllowedHosts(value) {
  if (value instanceof Set) return normalizeAllowedHosts([...value]);
  if (Array.isArray(value)) return normalizeAllowedHosts(value);
  if (typeof value === 'string') {
    return normalizeAllowedHosts(value.split(',').map((item) => item.trim()).filter(Boolean));
  }
  if (value == null || value === '') return new Set(DEFAULT_ALLOWED_HOSTS);
  throw new Error('allowed hosts must be a string, array, set, or empty');
}

export function createHostGuard({ allowedHosts = null, allowPrivateNetworks = true } = {}) {
  const allowed = parseAllowedHosts(allowedHosts);
  return function guardHost(headersOrHost) {
    const hostHeader = typeof headersOrHost === 'string' ? headersOrHost : getHeader(headersOrHost, 'host');
    const host = normalizeHostHeader(hostHeader);
    if (!host) return { allowed: false, host: null, reason: 'invalid-host' };
    if (allowed.has(host) || allowed.has('*')) return { allowed: true, host, reason: 'allowed-host' };
    if (allowPrivateNetworks && isPrivateHost(host)) return { allowed: true, host, reason: 'private-host' };
    return { allowed: false, host, reason: 'untrusted-host' };
  };
}

export function assertAllowedHost(headersOrHost, options = {}) {
  const result = createHostGuard(options)(headersOrHost);
  if (!result.allowed) {
    throw new Error(`Rejected admin host: ${result.reason}`);
  }
  return result.host;
}

export function isPrivateHost(host) {
  const normalized = normalizeHostHeader(host);
  if (!normalized) return false;
  if (DEFAULT_ALLOWED_HOSTS.has(normalized)) return true;

  const ipv4 = parseIPv4(normalized);
  if (ipv4) {
    const [a, b] = ipv4;
    return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }

  if (!normalized.includes(':')) return false;
  return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
}

function normalizeAllowedHosts(hosts) {
  const normalized = new Set();
  for (const host of hosts) {
    if (host === '*') {
      normalized.add('*');
      continue;
    }
    const value = normalizeHostHeader(String(host));
    if (!value) throw new Error(`Invalid allowed host: ${host}`);
    normalized.add(value);
  }
  return normalized;
}

function isValidPortPart(portPart) {
  return portPart === '' || (portPart.startsWith(':') && isValidPort(portPart.slice(1)));
}

function isValidPort(port) {
  if (!/^\d{1,5}$/.test(port)) return false;
  const number = Number(port);
  return number >= 1 && number <= 65535;
}

function parseIPv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

function isValidHostName(host) {
  if (host === '') return false;
  if (isIP(host)) return true;
  if (!/^[a-z0-9.-]+$/.test(host) || host.length > 253) return false;
  return host.split('.').every((label) => label.length >= 1 && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-'));
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value[0] ?? null;
    if (typeof value === 'string') return value;
  }
  return null;
}
