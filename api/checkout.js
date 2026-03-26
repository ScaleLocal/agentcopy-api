// AgentCopyAI — Checkout router
// POST /api/checkout  { plan: 'starter'|'growth'|'scale' }
// Returns the correct Stripe Payment Link URL

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://agentcopyai.com';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { plan } = req.body || {};

  // Stripe Payment Links (public buy.stripe.com URLs — safe to include in code)
  // Created via Stripe API for ScaleLocal / AgentCopyAI
  const links = {
    starter: 'https://buy.stripe.com/eVqeVedVFfYbbZiaol3Je01',  // $249/mo + $249 setup, M2M
    growth:  'https://buy.stripe.com/7sYdRabNx13hfbu6853Je02',  // $249/mo, 6-month commitment
    scale:   'https://buy.stripe.com/5kQ14og3NaDR4wQ5413Je03',  // $249/mo, 12-month, month 12 free
  };

  const url = links[plan];
  if (!url) return res.status(400).json({ error: 'Invalid plan: must be starter, growth, or scale' });

  return res.status(200).json({ url });
}
