// Scheduled sweep: attribute demo leads to the business whose demo they
// came from. Tags recently-created, untagged contacts across all 5
// WakeUpAgent slots as "demo:<domain>" by matching each contact's
// creation time to the slot's provision log.
//
// Trigger: a scheduled task hits this every ~15 min (GET or POST).
// Optional guard: set RECONCILE_SECRET env var, then pass ?key=<secret>.

import { reconcileAll } from '../lib/wakeup.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = process.env.RECONCILE_SECRET;
  if (secret) {
    const key = (req.query && req.query.key) || req.headers['x-key'];
    if (key !== secret) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const hours = Number(req.query && req.query.hours) || 48;
  try {
    const results = await reconcileAll({ windowHours: hours });
    const tagged = results.reduce((a, r) => a + (r.tagged || 0), 0);
    console.log('[reconcile] tagged=' + tagged + ' ' + JSON.stringify(results));
    return res.status(200).json({ ok: true, tagged, results });
  } catch (e) {
    console.error('[reconcile] error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
