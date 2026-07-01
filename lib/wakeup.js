// Shared WakeUpAgent pool + demo lead-attribution helpers.
// Single source of truth for the 5-slot pool (imported by
// api/create-agent.js and api/reconcile-demo-tags.js).
//
// WHY THIS EXISTS
// The 5 demo sub-accounts are SHARED — every visitor rotates into one
// of them, so a contact created by the widget isn't inherently tied to
// the business whose demo it came from. To attribute demo leads we keep
// a small rolling "provision log" per slot (stored in a GHL custom
// value), then a scheduled sweep tags each demo contact by matching its
// creation time to the business active in that slot at that moment.
// Static tags via the Contacts API — no dynamic-tag limits.

export const WAKEUP_POOL = [
  { slot: 1, locationId: 'A0wI1MDgzCPxCGibhCJ5', pit: process.env.GHL_WAKEUP_PIT_1 || 'pit-ef5034b1-b7a3-440d-a900-69837fd5a201', chatWidgetId: '6a445fb54245a5c8f3fe2465', voiceAgentId: '6a445f394a7c3a61c199fa75', chatBotId: 'G7vMYdqvfj9y5blS3RJ3' },
  { slot: 2, locationId: '7eVrFCQ703JyxD0eFuQR', pit: process.env.GHL_WAKEUP_PIT_2 || 'pit-b41fb655-adaf-445f-899a-3394d849b55e', chatWidgetId: '6a44608855ef5e6413afdd5d', voiceAgentId: '6a445f6f6cf2b0b79f4a79f0', chatBotId: 'ts1t35BfxB8qB0Ffw4pB' },
  { slot: 3, locationId: 'pam1mGNUL3DcE2bKkSDz', pit: process.env.GHL_WAKEUP_PIT_3 || 'pit-78127f2f-3b0e-45dd-a628-302c218fa0d5', chatWidgetId: '6a4461d5bd10bf7f08de62f6', voiceAgentId: '6a445f706cf2b028b44a79f3', chatBotId: 'd6VSoMxJAXu1soYXFYko' },
  { slot: 4, locationId: 'zZWZN8leA0wAH8ztMNd9', pit: process.env.GHL_WAKEUP_PIT_4 || 'pit-9a8b11f0-3ff8-4131-8369-c93aa83c8236', chatWidgetId: '6a446239638eec5af41afc87', voiceAgentId: '6a445f724a7c3a74d299fa7e', chatBotId: '9Om83mm3KsvVV5HdOfwK' },
  { slot: 5, locationId: 'rmdCJwqWdHP3Lms0uiwj', pit: process.env.GHL_WAKEUP_PIT_5 || 'pit-33f4a570-0d34-412b-ac80-52b990922929', chatWidgetId: '6a4462a055ef5e6413b01bf7', voiceAgentId: '6a445f738af28a03320c8a0f', chatBotId: 'DqqN9sEmgHN8yg6PaRFH' },
];

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const DEMO_LOG_CV = 'wwu_demo_log';   // custom value holding recent provisions
const TAG_PREFIX = 'demo:';           // tag becomes e.g. "demo:riverside-hvac.com"
const MAX_LOG = 25;                   // rolling provisions kept per slot

async function ghl(path, token, opts = {}) {
  return fetch(GHL_BASE + path, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + token,
      Version: GHL_VERSION,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

async function getLogCustomValue(locationId, token) {
  const r = await ghl('/locations/' + locationId + '/customValues', token);
  if (!r.ok) return null;
  const d = await r.json().catch(() => ({}));
  return (d.customValues || []).find((c) => c.name === DEMO_LOG_CV) || null;
}

async function getOrCreateLogCustomValue(locationId, token) {
  let cv = await getLogCustomValue(locationId, token);
  if (cv) return cv;
  const r = await ghl('/locations/' + locationId + '/customValues', token, {
    method: 'POST',
    body: JSON.stringify({ name: DEMO_LOG_CV, value: '[]' }),
  });
  const d = await r.json().catch(() => ({}));
  return d.customValue || (await getLogCustomValue(locationId, token));
}

function parseLog(cv) {
  try {
    const a = JSON.parse((cv && cv.value) || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

// Called on every provision: append {t, d} (timestamp, domain) to the
// slot's rolling log. Non-fatal — never blocks the visitor's demo.
export async function appendDemoLog(slot, domain) {
  try {
    if (!slot || !domain) return;
    const cv = await getOrCreateLogCustomValue(slot.locationId, slot.pit);
    if (!cv) return;
    let arr = parseLog(cv);
    arr.push({ t: new Date().toISOString(), d: String(domain).toLowerCase() });
    if (arr.length > MAX_LOG) arr = arr.slice(-MAX_LOG);
    await ghl('/locations/' + slot.locationId + '/customValues/' + cv.id, slot.pit, {
      method: 'PUT',
      body: JSON.stringify({ name: DEMO_LOG_CV, value: JSON.stringify(arr) }),
    });
  } catch {
    /* attribution is best-effort; swallow */
  }
}

// Given the log and a contact-creation time (ms), return the business
// domain active in that slot at that moment (greatest t <= when).
function businessForTime(log, whenMs) {
  let best = null;
  let bestT = -1;
  for (const e of log) {
    const et = Date.parse(e.t);
    if (!isNaN(et) && et <= whenMs && et > bestT) {
      best = e.d;
      bestT = et;
    }
  }
  return best;
}

async function addContactTag(locationId, token, contactId, tag) {
  const r = await ghl('/contacts/' + contactId + '/tags', token, {
    method: 'POST',
    body: JSON.stringify({ tags: [tag] }),
  });
  return r.ok;
}

// Tag recently-created, still-untagged demo contacts in one slot,
// attributing each to the business active when it was created.
export async function reconcileSlot(slot, { windowHours = 48 } = {}) {
  const locationId = slot.locationId;
  const token = slot.pit;
  const cv = await getLogCustomValue(locationId, token);
  const log = parseLog(cv);
  if (!log.length) return { slot: slot.slot, tagged: 0, skipped: 0, note: 'no log yet' };

  const r = await ghl('/contacts/?locationId=' + locationId + '&limit=100', token);
  if (!r.ok) return { slot: slot.slot, error: 'contacts ' + r.status };
  const d = await r.json().catch(() => ({}));
  const contacts = d.contacts || [];
  const cutoff = Date.now() - windowHours * 3600 * 1000;

  let tagged = 0;
  let skipped = 0;
  for (const c of contacts) {
    const added = Date.parse(c.dateAdded || c.dateCreated || '');
    if (isNaN(added) || added < cutoff) continue;
    const tags = (c.tags || []).map((t) => String(t).toLowerCase());
    if (tags.some((t) => t.startsWith(TAG_PREFIX))) continue; // already attributed
    const domain = businessForTime(log, added);
    if (!domain) { skipped++; continue; }
    const ok = await addContactTag(locationId, token, c.id, TAG_PREFIX + domain);
    if (ok) tagged++; else skipped++;
  }
  return { slot: slot.slot, tagged, skipped, scanned: contacts.length };
}

export async function reconcileAll(opts = {}) {
  const results = [];
  for (const slot of WAKEUP_POOL) {
    try {
      results.push(await reconcileSlot(slot, opts));
    } catch (e) {
      results.push({ slot: slot.slot, error: e.message });
    }
  }
  return results;
}
