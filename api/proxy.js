// AgentCopyAI — Site Proxy
// GET /api/proxy?url=https://wooster-roofing.com
// Fetches the target URL server-side, strips X-Frame-Options and CSP headers,
// rewrites relative URLs to absolute, and returns the HTML so it can be
// embedded in our iPhone frame without browser security blocks.

export default async function handler(req, res) {
  // CORS — allow our frontend
  const origin = process.env.ALLOWED_ORIGIN || 'https://agentcopyai.com';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  // Validate — only allow http/https
  let target;
  try {
    target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Bad protocol');
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Block proxying our own domain (prevent loops)
  if (target.hostname.includes('agentcopyai') || target.hostname.includes('vercel.app')) {
    return res.status(400).json({ error: 'Cannot proxy this domain' });
  }

  try {
    const upstream = await fetch(target.href, {
      headers: {
        // Pretend to be a real browser so sites don't return empty responses
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });

    const contentType = upstream.headers.get('content-type') || 'text/html';

    // For non-HTML resources (images, CSS, JS), stream through directly
    if (!contentType.includes('text/html')) {
      const body = await upstream.arrayBuffer();
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      // Remove frame-blocking headers
      return res.status(upstream.status).send(Buffer.from(body));
    }

    let html = await upstream.text();
    const base = target.origin + (target.pathname === '/' ? '' : target.pathname.replace(/\/[^\/]*$/, ''));

    // ── Rewrite URLs to absolute so assets load correctly ──
    // <base href> — set it first so relative resources resolve
    const baseTag = `<base href="${target.origin}/">`;

    // Inject <base> right after <head> if not present
    if (!html.includes('<base ')) {
      html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
    }

    // Rewrite root-relative links that would escape the proxy
    // Links (a href) — rewrite to stay within proxy
    html = html.replace(
      /(<a\s[^>]*href=["'])\/([^"'#][^"']*)(["'])/gi,
      (match, pre, path, post) => `${pre}${target.origin}/${path}${post}`
    );

    // Remove scripts that would break in the proxy context or cause redirects
    // (keep most scripts — we want the real site to render)
    // But remove service workers and manifest redirects
    html = html.replace(/<link[^>]+rel=["']?manifest["']?[^>]*>/gi, '');
    html = html.replace(/navigator\.serviceWorker\.register[^;]+;/gi, '');

    // Inject scroll-to-top so iframe always starts at the top
    const scrollReset = `<script>window.addEventListener('load',function(){window.scrollTo(0,0);document.documentElement.scrollTop=0;document.body.scrollTop=0;});<\/script>`;
    html = html.replace('</body>', scrollReset + '</body>');
    if (!html.includes(scrollReset)) html += scrollReset;

    // Respond — crucially WITHOUT X-Frame-Options or CSP frame-ancestors
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300'); // 5 min cache
    // Explicitly do NOT set X-Frame-Options or Content-Security-Policy
    // This is what allows our iframe to load it

    return res.status(200).send(html);

  } catch (err) {
    console.error('[Proxy] Error:', err.message);
    return res.status(502).json({ error: 'Could not fetch site', detail: err.message });
  }
}
