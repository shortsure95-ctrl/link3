// Vercel Serverless Function: /api/check
// Safe best-effort public LinkedIn profile availability checker.
// It does NOT use LinkedIn email/password/cookie/token and does NOT bypass login/rate limits.

const MAX_URLS_PER_REQUEST = 10;
const FETCH_TIMEOUT_MS = 10000;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function normalizeLinkedInUrl(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('Empty URL');
  let text = raw.trim();
  if (!text) throw new Error('Empty URL');
  if (!/^https?:\/\//i.test(text)) text = 'https://' + text;

  const u = new URL(text);
  const host = u.hostname.toLowerCase().replace(/^www\./, '');

  if (host !== 'linkedin.com') {
    throw new Error('Only linkedin.com profile URLs are allowed');
  }

  // Only allow public profile paths. This prevents arbitrary SSRF/fetching.
  const cleanPath = decodeURIComponent(u.pathname).replace(/\/+/g, '/');
  const okPath = /^\/(in|pub)\/[^/\s?#]+\/?$/i.test(cleanPath);
  if (!okPath) {
    throw new Error('Allowed format: linkedin.com/in/... or linkedin.com/pub/...');
  }

  const parts = cleanPath.split('/').filter(Boolean);
  const normalized = `https://www.linkedin.com/${parts[0].toLowerCase()}/${encodeURIComponent(parts[1]).replace(/%2D/gi, '-')}/`;
  return normalized;
}

function safeLower(s) {
  return String(s || '').toLowerCase();
}

function classifyHtml(html, httpStatus) {
  const lower = safeLower(html).slice(0, 400000);

  const notFoundNeedles = [
    'profile not found',
    'this profile is not available',
    'this page doesn’t exist',
    "this page doesn't exist",
    'page not found',
    'member not found',
    'unavailable profile',
    'the profile you requested could not be found',
    'something went wrong. try again',
  ];

  if (notFoundNeedles.some((needle) => lower.includes(needle))) {
    return {
      result: 'not_ok',
      label: 'Not OK / Not Found',
      confidence: 'medium',
      reason: 'LinkedIn response looked like unavailable/not-found page.',
      httpStatus,
    };
  }

  const loginNeedles = ['authwall', 'uas/login', 'join linkedin', 'sign in to linkedin', 'login'];
  if (loginNeedles.some((needle) => lower.includes(needle))) {
    return {
      result: 'ok_likely',
      label: 'Likely OK / Login Wall',
      confidence: 'medium',
      reason: 'LinkedIn did not return 404; it showed login/authwall. Manual verify recommended.',
      httpStatus,
    };
  }

  const profileNeedles = [
    'member-profile',
    'profile-card',
    'profile-topcard',
    'linkedin profile',
    'public profile',
    'person',
  ];
  if (profileNeedles.some((needle) => lower.includes(needle))) {
    return {
      result: 'ok',
      label: 'OK / Public Responded',
      confidence: 'high',
      reason: 'Public profile-like page responded successfully.',
      httpStatus,
    };
  }

  if (httpStatus >= 200 && httpStatus < 300) {
    return {
      result: 'ok_likely',
      label: 'Likely OK / Page Responded',
      confidence: 'low',
      reason: 'LinkedIn returned a successful page, but profile content was not clearly readable.',
      httpStatus,
    };
  }

  return {
    result: 'unknown',
    label: 'Unknown',
    confidence: 'low',
    reason: 'Could not confidently classify the LinkedIn response.',
    httpStatus,
  };
}

function classifyRedirect(location, httpStatus) {
  const loc = safeLower(location);

  if (!loc) {
    return {
      result: 'unknown',
      label: 'Unknown / Redirect',
      confidence: 'low',
      reason: 'LinkedIn redirected but did not expose the redirect destination.',
      httpStatus,
    };
  }

  if (loc.includes('/authwall') || loc.includes('uas/login') || loc.includes('/login') || loc.includes('checkpoint')) {
    return {
      result: 'ok_likely',
      label: 'Likely OK / Login Required',
      confidence: 'medium',
      reason: 'LinkedIn redirected to login/authwall instead of a not-found page. Manual verify recommended.',
      httpStatus,
      redirectTo: location,
    };
  }

  if (loc.includes('linkedin.com/in/') || loc.includes('linkedin.com/pub/')) {
    return {
      result: 'ok_likely',
      label: 'Likely OK / Canonical Redirect',
      confidence: 'medium',
      reason: 'LinkedIn redirected to another LinkedIn profile URL.',
      httpStatus,
      redirectTo: location,
    };
  }

  return {
    result: 'unknown',
    label: 'Unknown / Redirect',
    confidence: 'low',
    reason: 'LinkedIn redirected to a page that does not confirm status.',
    httpStatus,
    redirectTo: location,
  };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkOne(url) {
  const normalizedUrl = normalizeLinkedInUrl(url);

  const headers = {
    // Honest UA: this checker is not trying to bypass LinkedIn restrictions.
    'User-Agent': 'PublicProfileAvailabilityChecker/1.2 (+Vercel serverless; no login, no cookies)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.8,bn;q=0.6',
    'Cache-Control': 'no-cache',
  };

  let response;
  try {
    response = await fetchWithTimeout(normalizedUrl, {
      method: 'GET',
      redirect: 'manual',
      headers,
    });
  } catch (err) {
    return {
      input: url,
      url: normalizedUrl,
      result: 'unknown',
      label: 'Unknown / Request Failed',
      confidence: 'low',
      reason: err && err.name === 'AbortError' ? 'Request timed out.' : 'Server could not request this profile.',
      httpStatus: null,
    };
  }

  const status = response.status;
  const location = response.headers.get('location') || '';

  if (status === 404 || status === 410) {
    return {
      input: url,
      url: normalizedUrl,
      result: 'not_ok',
      label: 'Not OK / Possibly Removed',
      confidence: 'high',
      reason: `LinkedIn returned HTTP ${status}.`,
      httpStatus: status,
    };
  }

  // LinkedIn sometimes returns 999 for automated/non-browser traffic.
  if (status === 999 || status === 429 || status === 403 || status === 401) {
    return {
      input: url,
      url: normalizedUrl,
      result: 'unknown',
      label: 'Unknown / LinkedIn Blocked',
      confidence: 'low',
      reason: `LinkedIn blocked or limited the server request with HTTP ${status}. Manual verify needed.`,
      httpStatus: status,
    };
  }

  if (status >= 300 && status < 400) {
    return { input: url, url: normalizedUrl, ...classifyRedirect(location, status) };
  }

  if (status >= 500) {
    return {
      input: url,
      url: normalizedUrl,
      result: 'unknown',
      label: 'Unknown / LinkedIn Server Error',
      confidence: 'low',
      reason: `LinkedIn returned HTTP ${status}. Retry later.`,
      httpStatus: status,
    };
  }

  let html = '';
  try {
    html = await response.text();
  } catch (err) {
    return {
      input: url,
      url: normalizedUrl,
      result: status >= 200 && status < 300 ? 'ok_likely' : 'unknown',
      label: status >= 200 && status < 300 ? 'Likely OK / No Body' : 'Unknown / No Body',
      confidence: 'low',
      reason: 'Response body could not be read, but HTTP status was received.',
      httpStatus: status,
    };
  }

  return { input: url, url: normalizedUrl, ...classifyHtml(html, status) };
}

module.exports = async function handler(req, res) {
  cors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  let urls = [];
  try {
    urls = Array.isArray(req.body?.urls) ? req.body.urls : [];
  } catch (_) {
    urls = [];
  }

  urls = urls.filter((x) => typeof x === 'string' && x.trim()).slice(0, MAX_URLS_PER_REQUEST);
  if (!urls.length) {
    return res.status(400).json({ ok: false, error: 'No URLs provided' });
  }

  const results = [];
  for (const raw of urls) {
    try {
      results.push(await checkOne(raw));
    } catch (err) {
      results.push({
        input: raw,
        url: raw,
        result: 'invalid',
        label: 'Invalid URL',
        confidence: 'high',
        reason: err.message || 'Invalid LinkedIn URL.',
        httpStatus: null,
      });
    }
  }

  return res.status(200).json({ ok: true, results });
};
