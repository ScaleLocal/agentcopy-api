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
    html = html.replace(/\scrossorigin(="[^"]*")?/gi, '');

    // ── 2. Rewrite root-relative URLs to absolute ──────────────────────────
    html = html.replace(/(\s(?:src|href|action|data-src|data-href)=['"])\//g, `$1${siteOrigin}/`);
    html = html.replace(/url\((['"]?)\//g, `url($1${siteOrigin}/`);

    // ── 3. Add <base> tag ──────────────────────────────────────────────────
    if (!html.includes('<base ')) {
      html = html.replace(/(<head[^>]*>)/i, `$1<base href="${siteOrigin}/">`);
    }

    // ── 4. Strip security headers that break iframes ──────────────────────
    html = html.replace(/<link[^>]+rel=["']?manifest["']?[^>]*>/gi, '');
    html = html.replace(/navigator\.serviceWorker\.register[^;]+;/gi, '');
    html = html.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
    html = html.replace(/<meta[^>]+http-equiv=["']X-Frame-Options["'][^>]*>/gi, '');

    // ── 5. Inject script at top of <head> ─────────────────────────────────
    const headScript = `<script>
// Fix SPA blank page: reset pathname before app router boots
(function(){
  try { if(window.location.pathname !== '/') history.replaceState(null,'','/'); } catch(e){}
})();

// Pre-accept consent cookies so banners/popups never initialize
(function(){
  var cookies = [
    'terms_accepted=true',
    'moove_gdpr_popup={"strict":1,"thirdparty":1,"advanced":1}',
    'cookielawinfo-checkbox-necessary=yes',
    'cookielawinfo-checkbox-analytics=yes',
    'cookielawinfo-checkbox-functional=yes',
    'CookieConsent=true',
    'cookie_consent=accepted',
    'gdpr_cookie_accepted=true'
  ];
  var opts = '; max-age=31536000; path=/; samesite=lax';
  cookies.forEach(function(c){ document.cookie = c + opts; });
})();

// Hide consent/cookie/terms UI elements via CSS — injected before page CSS
document.write('<style id="_proxy_hide">' +
  '#moove_gdpr_cookie_info_bar, #moove_gdpr_cookie_modal,' +
  '#cookie-notice, #cookie-banner, #cookie-law-info-bar,' +
  '.cookie-notice, .cookie-banner, .cookie-bar,' +
  '#onetrust-banner-sdk, #onetrust-consent-sdk,' +
  '.iubenda-cs-container, [id*="cookieyes"], [class*="cookieyes"],' +
  '[id*="cky-"], [class*="cky-"], [id*="termly-"], [class*="termly-"],' +
  '#terms-popup, .modal-terms, .terms-modal,' +
  '[id*="disclaimer"]:not(section):not(p), [id*="liability"]:not(section):not(p)' +
  '{ display:none !important; visibility:hidden !important; }' +
'</style>');

// MutationObserver: catch and remove the Asahi terms popup (500ms delayed)
// Only targets the specific #terms-popup id — not broad "popup" classes
document.addEventListener('DOMContentLoaded', function() {
  var obs = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      m.addedNodes.forEach(function(node) {
        if (node.nodeType !== 1) return;
        if (node.id === 'terms-popup' || node.classList.contains('modal-terms')) {
          node.remove();
        }
      });
    });
  });
  obs.observe(document.body, { childList: true, subtree: false });

  // Block link navigation (display-only demo)
  document.addEventListener('click', function(e) {
    var a = e.target.closest('a');
    if (a && a.href && !a.href.startsWith('#') && !a.href.startsWith('mailto:') && !a.href.startsWith('tel:')) {
      e.preventDefault();
      e.stopPropagation();
    }
    // Block form submissions
  }, true);

  document.addEventListener('submit', function(e) {
    e.preventDefault();
    e.stopPropagation();
  }, true);
});
<\/script>`;

    html = html.replace(/(<head[^>]*>)/i, `$1${headScript}`);

    // ── 6. Scroll reset after load ─────────────────────────────────────────
    const scrollReset = `<script>window.addEventListener('load',function(){setTimeout(function(){window.scrollTo(0,0);},200);});<\/script>`;
    html = html.includes('</body>') ? html.replace('</body>', scrollReset + '</body>') : html + scrollReset;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).send(html);

  } catch (err) {
    console.error('[Proxy] Error:', err.message);
    return res.status(502).json({ error: 'Could not fetch site', detail: err.message });
  }
}
