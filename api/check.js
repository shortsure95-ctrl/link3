const MAX_URLS = 25;
const TIMEOUT_MS = 7000;
const ALLOWED_PREFIXES = ['/in/', '/pub/'];

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(JSON.stringify(data));
}

function normalizeLinkedInUrl(raw) {
  const original = String(raw || '').trim();
  if (!original) return { ok: false, original, error: 'Empty URL' };

  let value = original;
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value;

  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    return { ok: false, original, error: 'Invalid URL format' };
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'linkedin.com') {
    return { ok: false, original, error: 'Only linkedin.com profile links are allowed' };
  }

  let pathname = parsed.pathname.replace(/\/+/g, '/');
  if (!pathname.endsWith('/')) pathname += '/';
  const lowerPath = pathname.toLowerCase();
  const validPath = ALLOWED_PREFIXES.some((prefix) => lowerPath.startsWith(prefix) && lowerPath.length > prefix.length);

  if (!validPath) {
    return { ok: false, original, error: 'Only linkedin.com/in/... or linkedin.com/pub/... profile links are allowed' };
  }

  return {
    ok: true,
    original,
    url: 'https://www.linkedin.com' + pathname,
  };
}

async function checkOne(item) {
  if (!item.ok) {
    return {
      input: item.original,
      url: item.original,
      status: 'invalid',
      label: 'Invalid Link',
      httpStatus: null,
      message: item.error,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(item.url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
    });

    clearTimeout(timer);

    const httpStatus = response.status;
    const location = response.headers.get('location') || '';
    const lowerLocation = location.toLowerCase();

    if (httpStatus >= 200 && httpStatus <= 299) {
      return {
        input: item.original,
        url: item.url,
        status: 'ok',
        label: 'OK / Active Public',
        httpStatus,
        message: 'Public profile page responded successfully.',
      };
    }

    if ([301, 302, 303, 307, 308].includes(httpStatus)) {
      if (lowerLocation.includes('/login') || lowerLocation.includes('/checkpoint') || lowerLocation.includes('/authwall')) {
        return {
          input: item.original,
          url: item.url,
          status: 'unknown',
          label: 'Unknown / Login Wall',
          httpStatus,
          message: 'LinkedIn redirected this request to login/auth wall. Manual verify needed.',
        };
      }

      return {
        input: item.original,
        url: item.url,
        status: 'ok',
        label: 'OK / Redirected',
        httpStatus,
        message: 'Profile URL redirected but still responded.',
      };
    }

    if (httpStatus === 404 || httpStatus === 410) {
      return {
        input: item.original,
        url: item.url,
        status: 'not_ok',
        label: 'Not OK / Possibly Ban or Removed',
        httpStatus,
        message: 'Profile returned not found/removed status. This can mean removed, unavailable, or possibly banned.',
      };
    }

    if ([401, 403, 429, 999].includes(httpStatus)) {
      return {
        input: item.original,
        url: item.url,
        status: 'unknown',
        label: 'Unknown / Blocked',
        httpStatus,
        message: 'LinkedIn blocked or rate-limited the server request. Manual verify needed.',
      };
    }

    return {
      input: item.original,
      url: item.url,
      status: 'unknown',
      label: 'Unknown',
      httpStatus,
      message: 'Could not confidently identify this profile status.',
    };
  } catch (e) {
    clearTimeout(timer);
    return {
      input: item.original,
      url: item.url,
      status: 'unknown',
      label: 'Unknown / Request Failed',
      httpStatus: null,
      message: e && e.name === 'AbortError' ? 'Request timeout. Manual verify needed.' : 'Server request failed. Manual verify needed.',
    };
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed. Use POST.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const urls = Array.isArray(body.urls) ? body.urls : [];

    if (!urls.length) return sendJson(res, 400, { ok: false, error: 'No URLs received.' });

    const cleanUrls = [...new Set(urls.map((u) => String(u || '').trim()).filter(Boolean))].slice(0, MAX_URLS);
    const normalized = cleanUrls.map(normalizeLinkedInUrl);

    // Run in parallel so Vercel Hobby deployment does not timeout.
    const results = await Promise.all(normalized.map(checkOne));

    const summary = results.reduce((acc, row) => {
      acc.total += 1;
      if (row.status === 'ok') acc.ok += 1;
      else if (row.status === 'not_ok') acc.not_ok += 1;
      else if (row.status === 'invalid') acc.invalid += 1;
      else acc.unknown += 1;
      return acc;
    }, { total: 0, ok: 0, not_ok: 0, unknown: 0, invalid: 0 });

    return sendJson(res, 200, {
      ok: true,
      checkedAt: new Date().toISOString(),
      summary,
      results,
      note: 'Not OK is not a 100% ban confirmation. It can also mean removed, private, unavailable, or not found. Unknown usually means LinkedIn blocked or rate-limited the server request.',
    });
  } catch (_) {
    return sendJson(res, 500, { ok: false, error: 'Server error while checking links.' });
  }
};
