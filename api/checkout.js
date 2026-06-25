// AgentCopyAI — Checkout router
// POST /api/checkout  { plan: 'talking-website' | 'talking-website-scheduling' }
// (Legacy aliases supported: 'm2m', '6mo', '12mo' → all route to $19 talking-website
//  since the old 3-tier $249/mo model has been deprecated as of 2026-06-25.)
// Returns the correct Stripe Payment Link URL.

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://agentcopyai.com';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { plan } = req.body || {};

  // Stripe Payment Links — AgentCopyAI ($19 / $29 tier model, locked 2026-06-25)
  // Both collect at checkout: name, email, phone, billing address, business_name,
  // website_url, industry_trade. Apple Pay / Google Pay enabled. Promo codes allowed.
  const links = {
    'talking-website':            'https://buy.stripe.com/bJeaEY7xh4fte7qcwt3Je0M', // $19/mo recurring
    'talking-website-scheduling': 'https://buy.stripe.com/aFa9AUaJth2fd3mbsp3Je0N', // $29/mo recurring
    // Legacy aliases — anything still calling with the old plan codes routes to $19 base tier.
    'm2m':  'https://buy.stripe.com/bJeaEY7xh4fte7qcwt3Je0M',
    '6mo':  'https://buy.stripe.com/bJeaEY7xh4fte7qcwt3Je0M',
    '12mo': 'https://buy.stripe.com/bJeaEY7xh4fte7qcwt3Je0M',
  };

  const url = links[plan];
  if (!url) return res.status(400).json({ error: 'Invalid plan. Use: talking-website OR talking-website-scheduling' });

  return res.status(200).json({ url });
}
