// AgentCopyAI — Site Proxy
// GET /api/proxy?url=https://wooster-roofing.com
// Fetches the target URL server-side, strips X-Frame-Options and CSP headers,
// rewrites ALL relative URLs to absolute, and returns embeddable HTML.

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://agentcopyai.com';
  res.setHeader('Access-Control-Allow-Origin', origin);
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
        'Accept-Encoding': 'gzip, deflate, br',
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
    const siteOrigin = target.origin; // e.g. https://spendlocal.net

    // ── Step 1: Rewrite ALL root-relative asset URLs to absolute BEFORE anything else ──
    // This fixes Vite/React/Next SPAs where <script src="/assets/..."> loads JS bundles.
    // We must do this before injecting <base> because browsers process <script> and
    // <link rel="modulepreload"> tags before <base> takes effect.

    // src="/..." → src="https://origin/..."
    html = html.replace(
      /(\s(?:src|href|action|data-src|data-href)=["'])\/(?!\/)/g,
      `$1${siteOrigin}/`
    );

    // url(/...) in inline styles → url(https://origin/...)
    html = html.replace(
      /url\((['"]?)\/(?!\/)/g,
      `url($1${siteOrigin}/`
    );

    // srcset="/..." → srcset="https://origin/..."  (may have multiple entries)
    html = html.replace(
      /(\ssrcset=["'][^"']*\s?)\/(?!\/)/g,
      `$1${siteOrigin}/`
    );

    // import("/"...) and import '/'... in inline scripts (Vite dynamic imports)
    html = html.replace(
      /(import\s*\(["'])\/(?!\/)/g,
      `$1${siteOrigin}/`
    );
    html = html.replace(
      /(from\s+["'])\/(?!\/)/g,
      `$1${siteOrigin}/`
    );

    // ── Step 2: Inject <base> as FIRST child of <head> (belt-and-suspenders) ──
    if (!html.includes('<base ')) {
      html = html.replace(/(<head[^>]*>)/i, `$1<base href="${siteOrigin}/">`);
    }

    // ── Step 3: Strip things that break iframe context ──
    html = html.replace(/<link[^>]+rel=["']?manifest["']?[^>]*>/gi, '');
    html = html.replace(/navigator\.serviceWorker\.register[^;]+;/gi, '');
    // Remove Content-Security-Policy meta tags (they'd block our widget)
    html = html.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');

    // ── Step 4: Scroll to top on load ──
    const scrollReset = `<script>window.addEventListener('load',function(){setTimeout(function(){window.scrollTo(0,0);},100);});<\/script>`;
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
