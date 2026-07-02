// Slot heartbeat — keeps a live demo's lease on its slot fresh so
// assignment won't reclaim a slot that's actively being shown.
// POST /api/heartbeat { slot: <1-5>, slug: "<business-slug>" }
// Returns { ok, owned, by }. owned=false → the slot was taken by another
// demo; the page should re-claim a fresh slot.

import { heartbeatSlot } from '../lib/wakeup.js';

export default async function handler(req, res) {
  const origin = req.headers?.origin || '';
  const allowed = ['https://websitewakeup.com', 'https://www.websitewakeup.com', 'https://scalelocal.net', 'https://www.scalelocal.net', 'https://agentcopyai.com', 'https://www.agentcopyai.com'];
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : 'https://websitewakeup.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method' });

  const { slot, slug } = req.body || {};
  if (slot == null || !slug) return res.status(400).json({ ok: false, error: 'slot and slug required' });

  try {
    const r = await heartbeatSlot(slot, slug);
    return res.status(200).json({ ok: true, ...r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
