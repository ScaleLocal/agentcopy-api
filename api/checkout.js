// AgentCopyAI — Checkout router
// POST /api/checkout
//   { plan, slug, bizName, url, wakeUpSlot, name, email, phone }
//
// Creates a Stripe Checkout Session (recurring subscription) and returns its
// hosted URL. The demo context (slug / business / rotated WakeUpAgent slot) is
// attached as session metadata so /api/webhook knows exactly which business
// paid and can auto-provision their permanent sub-account (Task #40).
//
// Falls back to the static Stripe Payment Links if STRIPE_KEY is not set, so
// the CTA keeps working even before the secret is added to Vercel env.
//
// Uses Stripe's REST API directly (no stripe SDK dependency, matching the rest
// of this codebase which verifies webhooks by hand).

const PRICES = {
  // Price IDs from API_Keys.md -> "Stripe Payment Links — AgentCopyAI Homepage"
  'talking-website':            'price_1TmHZuIQF1r4C5QsPij2Tl52', // $19/mo
  'talking-website-scheduling': 'price_1TmHZwIQF1r4C5QsOBhufeHZ', // $29/mo
};

// Product tag written to metadata so the webhook's PLAN_NAMES/logic keeps working.
const PRODUCT_TAG = {
  'talking-website':            'talking_website',
  'talking-website-scheduling': 'talking_website_scheduling',
};

// Static payment-link fallbacks (no metadata) if STRIPE_KEY unset.
const FALLBACK_LINKS = {
  'talking-website':            'https://buy.stripe.com/bJeaEY7xh4fte7qcwt3Je0M',
  'talking-website-scheduling': 'https://buy.stripe.com/aFa9AUaJth2fd3mbsp3Je0N',
};

export default async function handler(req, res) {
  const origin = req.headers?.origin || '';
  const allowed = ['https://agentcopyai.com', 'https://www.agentcopyai.com', 'https://websitewakeup.com', 'https://www.websitewakeup.com', 'https://scalelocal.net', 'https://www.scalelocal.net'];
  const corsOrigin = allowed.includes(origin) ? origin : (process.env.ALLOWED_ORIGIN || 'https://agentcopyai.com');
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  // Accept both the new plan slugs and legacy tier codes.
  let plan = body.plan || 'talking-website-scheduling';
  if (plan === 'm2m' || plan === '6mo' || plan === '12mo' || plan === 19 || plan === '19') plan = 'talking-website';
  if (plan === 29 || plan === '29') plan = 'talking-website-scheduling';

  const price = PRICES[plan];
  if (!price) return res.status(400).json({ error: 'Invalid plan' });

  const { slug = '', bizName = '', url = '', wakeUpSlot = '', email = '' } = body;

  // If no secret key configured, degrade gracefully to the static link.
  const STRIPE_KEY = process.env.STRIPE_KEY;
  if (!STRIPE_KEY) {
    console.warn('[Checkout] STRIPE_KEY not set — returning static payment link (no metadata)');
    return res.status(200).json({ url: FALLBACK_LINKS[plan], degraded: true });
  }

  // Where to send the buyer after payment / cancel.
  const successBase = (corsOrigin && corsOrigin.startsWith('http')) ? corsOrigin : 'https://agentcopyai.com';

  const params = {
    mode: 'subscription',
    'line_items[0][price]': price,
    'line_items[0][quantity]': 1,
    success_url: `${successBase}/welcome.html?plan=${encodeURIComponent(plan)}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${successBase}/`,
    allow_promotion_codes: true,
    billing_address_collection: 'required',
    'phone_number_collection[enabled]': true,
    // Reference the demo so we can trace it end-to-end.
    client_reference_id: slug || bizName || 'wakeup-demo',
    // METADATA — read by /api/webhook on checkout.session.completed so
    // provisioning knows the exact business, source URL and rotated slot.
    'metadata[product]': PRODUCT_TAG[plan] || plan,
    'metadata[plan]': plan,
    'metadata[slug]': slug,
    'metadata[bizName]': bizName,
    'metadata[url]': url,
    'metadata[wakeUpSlot]': String(wakeUpSlot || ''),
    'metadata[source]': 'websitewakeup_demo',
    // Copy the same metadata onto the subscription so it survives on renewals.
    'subscription_data[metadata][product]': PRODUCT_TAG[plan] || plan,
    'subscription_data[metadata][slug]': slug,
    'subscription_data[metadata][bizName]': bizName,
    'subscription_data[metadata][url]': url,
    'subscription_data[metadata][wakeUpSlot]': String(wakeUpSlot || ''),
  };
  // Prefill the buyer's email if we captured it in the pre-checkout modal.
  if (email) params['customer_email'] = email;

  const encoded = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  try {
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: encoded,
    });
    const data = await stripeRes.json();
    if (!stripeRes.ok) {
      console.error('[Checkout] Stripe error', stripeRes.status, data?.error?.message);
      // Degrade to static link so the buyer can still pay.
      return res.status(200).json({ url: FALLBACK_LINKS[plan], degraded: true, error: data?.error?.message });
    }
    console.log(`[Checkout] Session ${data.id} created — plan=${plan} slug=${slug} slot=${wakeUpSlot}`);
    return res.status(200).json({ url: data.url, sessionId: data.id });
  } catch (err) {
    console.error('[Checkout] Unreachable:', err.message);
    return res.status(200).json({ url: FALLBACK_LINKS[plan], degraded: true, error: 'stripe_unreachable' });
  }
}
