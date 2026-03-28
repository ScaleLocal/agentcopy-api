// AgentCopyAI — Checkout router
// POST /api/checkout  { plan: 'm2m'|'6mo'|'12mo' }
// Returns the correct Stripe Payment Link URL

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://agentcopyai.com';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { plan } = req.body || {};

  // Stripe Payment Links — ScaleLocal / AgentCopyAI
  // All collect: name, email, phone, company name, website URL
  const links = {
    m2m:  'https://buy.stripe.com/8x2bJ25p9dQ38N69kh3Je07', // $249 setup (One-Time Setup Fee) + $249/mo (AI Website Agent) M2M
    '6mo':'https://buy.stripe.com/eVq4gAg3N3bp4wQdAx3Je05', // $249/mo · 6-month · no setup
    '12mo':'https://buy.stripe.com/fZu8wQ2cX7rF4wQaol3Je06', // $249/mo · 12-month · month 12 free
  };

  const url = links[plan];
  if (!url) return res.status(400).json({ error: 'Invalid plan. Use: m2m, 6mo, or 12mo' });

  return res.status(200).json({ url });
}
