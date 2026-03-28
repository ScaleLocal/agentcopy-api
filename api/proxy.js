// AgentCopyAI — Site Proxy
// GET /api/proxy?url=https://wooster-roofing.com

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://agentcopyai.com';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  let target;
  try {
    target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Bad protocol');
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (target.hostname.includes('agentcopyai') || target.hostname.includes('vercel.app')) {
    return res.status(400).json({ error: 'Cannot proxy this domain' });
  }

  try {
    const upstream = await fetch(target.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });

    const contentType = upstream.headers.get('content-type') || 'text/html';

    if (!contentType.includes('text/html')) {
      const body = await upstream.arrayBuffer();
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(upstream.status).send(Buffer.from(body));
    }

    let html = await upstream.text();
    const siteOrigin = target.origin;

    // ── 1. Remove crossorigin attributes ──────────────────────────────────
    // Vite/webpack add crossorigin to module scripts. In our proxy context the
    // CORS origin check fails → scripts blocked → blank page. Remove it.
    html = html.replace(/\scrossorigin(="[^"]*")?/gi, '');

    // ── 2. Rewrite ALL root-relative URLs to absolute ─────────────────────
    html = html.replace(/(\s(?:src|href|action|data-src|data-href)=['"])\//g, `$1${siteOrigin}/`);
    html = html.replace(/url\((['"]?)\//g, `url($1${siteOrigin}/`);

    // ── 3. Inject <base> as first child of <head> ─────────────────────────
    if (!html.includes('<base ')) {
      html = html.replace(/(<head[^>]*>)/i, `$1<base href="${siteOrigin}/">`);
    }

    // ── 4. Strip iframe/proxy-breaking elements ───────────────────────────
    html = html.replace(/<link[^>]+rel=["']?manifest["']?[^>]*>/gi, '');
    html = html.replace(/navigator\.serviceWorker\.register[^;]+;/gi, '');
    html = html.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
    html = html.replace(/<meta[^>]+http-equiv=["']X-Frame-Options["'][^>]*>/gi, '');

    // ── 5. Critical injections — added as FIRST script in <head> ──────────
    const headInjection = `<script>
// Fix 1: React Router / Vue Router / Angular Router blank page fix
// When served via proxy, window.location.pathname = "/api/proxy" which
// matches no app routes → blank render. Reset to "/" before app boots.
(function(){
  try {
    if (window.location.pathname !== '/') {
      history.replaceState(null, '', '/');
    }
  } catch(e) {}
})();

// Fix 2: Block ALL navigation inside this demo iframe.
// This is a display-only demo — no clicks should navigate away.
// Covers: <a> links, <button> clicks that trigger location changes,
// cookie banners, consent dialogs, form submissions.
(function() {
  // Override location navigation methods immediately (before any scripts run)
  try {
    var noop = function() {};
    // Trap location changes
    var loc = window.location;
    Object.defineProperty(window, 'location', {
      get: function() { return loc; },
      set: function(v) { /* block navigation */ }
    });
    var _assign = loc.assign.bind(loc);
    loc.assign = noop;
    loc.replace = noop;
  } catch(e) {}

  document.addEventListener('DOMContentLoaded', function() {
    // Block link clicks
    document.addEventListener('click', function(e) {
      var a = e.target.closest('a');
      if (a && a.href && !a.href.startsWith('#') && !a.href.startsWith('mailto:') && !a.href.startsWith('tel:')) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      // Block buttons that are part of cookie/consent banners
      // Identified by common patterns: accept, reject, consent, cookie, gdpr, ccpa, dismiss, close
      var btn = e.target.closest('button, [role="button"]');
      if (btn) {
        var text = (btn.textContent || '').toLowerCase();
        var id = (btn.id || '').toLowerCase();
        var cls = (btn.className || '').toLowerCase();
        var combined = text + ' ' + id + ' ' + cls;
        var isCookieBtn = /accept|reject|decline|dismiss|consent|cookie|gdpr|ccpa|privacy|allow|deny|agree|disagree|necessary|preferences|close banner|got it/.test(combined);
        if (isCookieBtn) {
          e.preventDefault();
          e.stopPropagation();
          // Try to hide the banner instead
          var banner = btn.closest('[class*="cookie"],[class*="consent"],[class*="gdpr"],[class*="banner"],[class*="notice"],[id*="cookie"],[id*="consent"],[id*="gdpr"],[id*="banner"]');
          if (banner) banner.style.display = 'none';
          return false;
        }
      }
    }, true);

    // Block form submissions
    document.addEventListener('submit', function(e) {
      e.preventDefault();
      e.stopPropagation();
    }, true);

    // Block beforeunload navigation
    window.onbeforeunload = function() { return false; };
  });
})();
<\/script>`;

    html = html.replace(/(<head[^>]*>)/i, `$1${headInjection}`);

    // ── 6. Scroll to top after load ───────────────────────────────────────
    const scrollReset = `<script>window.addEventListener('load',function(){setTimeout(function(){window.scrollTo(0,0);},200);});<\/script>`;
    if (html.includes('</body>')) {
      html = html.replace('</body>', scrollReset + '</body>');
    } else {
      html += scrollReset;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).send(html);

  } catch (err) {
    console.error('[Proxy] Error:', err.message);
    return res.status(502).json({ error: 'Could not fetch site', detail: err.message });
  }
}
