// AgentCopyAI — Site Proxy
// GET /api/proxy?url=https://wooster-roofing.com
// Fetches target URL server-side, strips security headers, rewrites all
// relative URLs to absolute, fixes CORS issues for SPA frameworks.

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

    // Non-HTML: pass through (images, CSS, fonts etc)
    if (!contentType.includes('text/html')) {
      const body = await upstream.arrayBuffer();
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(upstream.status).send(Buffer.from(body));
    }

    let html = await upstream.text();
    const siteOrigin = target.origin; // e.g. https://spendlocal.net

    // ── 1. Remove crossorigin attributes ──────────────────────────────────────
    // Vite/webpack add crossorigin to <script type="module"> and <link rel="modulepreload">.
    // When our proxy serves the HTML, the browser origin is our proxy domain.
    // crossorigin triggers a CORS preflight — spendlocal's JS bundle CORS headers
    // only allow 'self' (spendlocal.net), so the CORS check fails and the script
    // never executes → blank white page.
    // Fix: remove crossorigin so the browser fetches these as normal (no-cors) requests.
    html = html.replace(/\scrossorigin(="[^"]*")?/gi, '');

    // ── 2. Rewrite ALL root-relative URLs to absolute ─────────────────────────
    // Must happen BEFORE <base> injection because browsers process <script src>
    // and <link href> before <base> takes effect in some parsers.
    
    // src="/..." href="/..." action="/..."
    html = html.replace(
      /(\s(?:src|href|action|data-src|data-href)=['"])\//g,
      `$1${siteOrigin}/`
    );
    // url(/...) in inline styles
    html = html.replace(/url\((['"]?)\//g, `url($1${siteOrigin}/`);
    // srcset entries starting with /
    html = html.replace(/(\ssrcset=['"][^'"]*)\s\//g, `$1 ${siteOrigin}/`);

    // ── 3. Inject <base> as first child of <head> (belt-and-suspenders) ──────
    if (!html.includes('<base ')) {
      html = html.replace(/(<head[^>]*>)/i, `$1<base href="${siteOrigin}/">`);
    }

    // ── 4. Strip things that break iframe/proxy context ───────────────────────
    // Manifest links (not needed, can cause errors)
    html = html.replace(/<link[^>]+rel=["']?manifest["']?[^>]*>/gi, '');
    // Service worker registration (breaks in iframe context)
    html = html.replace(/navigator\.serviceWorker\.register[^;]+;/gi, '');
    // CSP meta tags — would block our GHL widget injection
    html = html.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
    // Remove X-Frame-Options meta equivalent if any
    html = html.replace(/<meta[^>]+http-equiv=["']X-Frame-Options["'][^>]*>/gi, '');

    // ── 5. Scroll to top after load ───────────────────────────────────────────
    const scrollReset = `<script>window.addEventListener('load',function(){setTimeout(function(){window.scrollTo(0,0);},150);});<\/script>`;
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
