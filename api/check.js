const MAX_URLS_PER_REQUEST = 25;
const TIMEOUT_MS = 12000;

function send(res, code, data) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.end(JSON.stringify(data));
}

function isAllowedLinkedInProfile(raw) {
  try {
    const u = new URL(String(raw).trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'linkedin.com') return { ok: false, reason: 'Only linkedin.com profile URLs are allowed' };
    const path = u.pathname.replace(/\/+/g, '/');
    if (!(/^\/in\/[^/?#]+\/?$/i.test(path) || /^\/pub\/[^?#]+/i.test(path))) {
      return { ok: false, reason: 'Only /in/ or /pub/ profile URLs are allowed' };
    }
    u.protocol = 'https:';
    u.hostname = 'www.linkedin.com';
    u.search = '';
    u.hash = '';
    return { ok: true, url: u.toString().replace(/\/$/, '/') };
  } catch (e) {
    return { ok: false, reason: 'Invalid URL' };
  }
}

function classifyByStatus(status) {
  if (status === 404 || status === 410) {
    return { status: 'not_ok', confidence: 95, reason: `HTTP ${status}: profile/page not found`, needsManual: false };
  }
  if (status === 400) {
    return { status: 'not_ok', confidence: 80, reason: 'Bad profile URL or removed page', needsManual: true };
  }
  if (status === 401 || status === 403 || status === 429 || status === 999) {
    return { status: 'unknown', confidence: 0, reason: `HTTP ${status}: LinkedIn blocked or restricted the automated check`, needsManual: true };
  }
  if (status >= 500) {
    return { status: 'unknown', confidence: 0, reason: `HTTP ${status}: LinkedIn/server temporary error`, needsManual: true };
  }
  return null;
}

function findAny(text, patterns) {
  return patterns.find((p) => text.includes(p));
}

function classifyContent(text, finalUrl, httpStatus) {
  const lower = (text || '').slice(0, 220000).toLowerCase();
  const urlLower = String(finalUrl || '').toLowerCase();

  if (urlLower.includes('/checkpoint/') || urlLower.includes('/login') || urlLower.includes('/uas/login')) {
    return { status: 'unknown', confidence: 0, reason: 'Redirected to LinkedIn login/checkpoint', needsManual: true };
  }

  const notFound = findAny(lower, [
    'profile not found',
    'this profile is not available',
    'this page doesn’t exist',
    "this page doesn't exist",
    'page not found',
    'member not found',
    'profile unavailable',
    'an exact match could not be found',
    'the profile you are looking for is not available',
    'the profile you requested was not found',
    'no longer available'
  ]);
  if (notFound) {
    return { status: 'not_ok', confidence: 88, reason: `LinkedIn page says: ${notFound}`, needsManual: true };
  }

  const botBlock = findAny(lower, [
    'authwall',
    'sign in to view',
    'join linkedin',
    'login to linkedin',
    'checkpoint',
    'captcha',
    'unusual traffic',
    'automated access',
    'security verification',
    'guest_homepage'
  ]);

  const strongProfile = findAny(lower, [
    '"@type":"person"',
    '"@type": "person"',
    'schema.org/person',
    'profile topcard',
    'top-card-layout',
    'profile-card',
    'member-profile',
    'profile_v2',
    'public-profile'
  ]);

  if (strongProfile && !botBlock) {
    return { status: 'ok', confidence: 92, reason: 'Public profile content detected', needsManual: false };
  }

  if (httpStatus >= 200 && httpStatus < 300) {
    // If LinkedIn returned a successful response for the profile URL but content is authwalled,
    // it is better to mark this as likely_ok, not confirmed OK.
    if (botBlock) {
      return { status: 'likely_ok', confidence: 60, reason: 'LinkedIn responded but asked for login/authwall; profile may exist, manual confirm recommended', needsManual: true };
    }
    // Some public pages do not expose clear markers. Treat as likely rather than unknown.
    return { status: 'likely_ok', confidence: 55, reason: 'LinkedIn returned HTTP 200 but profile markers were unclear', needsManual: true };
  }

  if (httpStatus >= 300 && httpStatus < 400) {
    return { status: 'unknown', confidence: 0, reason: `Redirected with HTTP ${httpStatus}`, needsManual: true };
  }

  return { status: 'unknown', confidence: 0, reason: 'Could not confidently classify the profile', needsManual: true };
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,bn;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'User-Agent': 'Mozilla/5.0 (compatible; SafePublicProfileChecker/1.0; +https://vercel.app)'
      }
    });
    const status = response.status;
    const finalUrl = response.url || url;
    let body = '';
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text') || contentType.includes('html') || contentType.includes('json') || !contentType) {
      body = await response.text();
    }
    return { response, status, finalUrl, body };
  } finally {
    clearTimeout(timer);
  }
}

async function checkOne(originalUrl) {
  const checkedAt = new Date().toISOString();
  const valid = isAllowedLinkedInProfile(originalUrl);
  if (!valid.ok) {
    return {
      input: originalUrl,
      normalizedUrl: null,
      status: 'invalid',
      confidence: 100,
      httpStatus: null,
      finalUrl: null,
      reason: valid.reason,
      needsManual: false,
      checkedAt
    };
  }

  try {
    const first = await fetchWithTimeout(valid.url, TIMEOUT_MS);
    const statusRule = classifyByStatus(first.status);
    let classified = statusRule || classifyContent(first.body, first.finalUrl, first.status);

    return {
      input: originalUrl,
      normalizedUrl: valid.url,
      status: classified.status,
      confidence: classified.confidence,
      httpStatus: first.status,
      finalUrl: first.finalUrl,
      reason: classified.reason,
      needsManual: classified.needsManual,
      checkedAt
    };
  } catch (err) {
    return {
      input: originalUrl,
      normalizedUrl: valid.url,
      status: 'unknown',
      confidence: 0,
      httpStatus: null,
      finalUrl: null,
      reason: err && err.name === 'AbortError' ? 'Request timeout. Try slow retry or manual check.' : 'Network/server fetch failed',
      needsManual: true,
      checkedAt
    };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return send(res, 200, { ok: true });
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' });

  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = body ? JSON.parse(body) : {}; } catch (e) { body = {}; }
  }

  const urls = Array.isArray(body.urls) ? body.urls.slice(0, MAX_URLS_PER_REQUEST) : [];
  if (!urls.length) return send(res, 400, { ok: false, error: 'No URLs provided' });

  const results = [];
  for (const url of urls) {
    results.push(await checkOne(url));
    // Small pause inside a request if caller sends multiple URLs.
    await new Promise((r) => setTimeout(r, 250));
  }

  return send(res, 200, { ok: true, results, limit: MAX_URLS_PER_REQUEST });
}
