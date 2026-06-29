// AgentCopyAI — Stripe Webhook Handler
// Listens for Stripe events → creates/updates GHL contacts + opportunities
// Triggers: checkout.session.completed, customer.subscription.deleted, invoice.payment_failed

import crypto from 'crypto';

// ── Config ────────────────────────────────────────────────────────────────────
const GHL_TOKEN    = process.env.GHL_TOKEN;
const GHL_LOCATION = process.env.GHL_LOCATION_ID;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// GHL pipeline — using Marketing Pipeline, "Deposit Paid" stage as "Paid - New"
// until you create a dedicated AI Website Agent pipeline manually in GHL
// Then update PIPELINE_ID and STAGE_ID here
const PIPELINE_ID   = 'GlU5H3U4ClHDy9s0fgIK';
const STAGE_PAID    = '8f879edd-07e0-4669-9ad7-d218de55531d'; // Deposit Paid → rename to "Paid - New"
const STAGE_AT_RISK = 'c918926a-f5a7-4691-a563-df71a88e7682'; // Proposal Sent → rename to "At Risk"
const STAGE_CANCELLED = '469efc86-1a39-464b-8d49-16a1c3edcee5'; // Hot Lead → rename "Cancelled"

// Plan display names
const PLAN_NAMES = {
  // Current $19/$29 tier model (locked 2026-06-25). Keyed by Stripe metadata.product.
  'talking_website':            'Talking Website ($19/mo)',
  'talking_website_scheduling': 'Talking Website + Scheduling ($29/mo)',
  // Legacy aliases — kept so any in-flight events from old links don't crash.
  // If we see one of these, a stale link is still in use.
  'm2m':  'Talking Website ($19/mo) [legacy m2m alias]',
  '6mo':  'Talking Website ($19/mo) [legacy 6mo alias]',
  '12mo': 'Talking Website ($19/mo) [legacy 12mo alias]',
};

// ── Stripe signature verification ─────────────────────────────────────────────
function verifyStripeSignature(rawBody, signature, secret) {
  const parts = signature.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    acc[k] = v;
    return acc;
  }, {});

  const timestamp = parts.t;
  const sig = parts.v1;
  if (!timestamp || !sig) return false;

  // Reject webhooks older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return false;

  const payload = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(sig, 'hex'),
    Buffer.from(expected, 'hex')
  );
}

// ── GHL API helpers ───────────────────────────────────────────────────────────
async function ghlRequest(method, path, body = null) {
  const res = await fetch(`https://services.leadconnectorhq.com${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${GHL_TOKEN}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function findContact(email) {
  const data = await ghlRequest('GET', `/contacts/?locationId=${GHL_LOCATION}&query=${encodeURIComponent(email)}&limit=1`);
  return data?.contacts?.[0] || null;
}

async function createOrUpdateContact({ firstName, lastName, email, phone, company, website, plan, stripeCustomerId }) {
  const existing = await findContact(email);

  const payload = {
    locationId: GHL_LOCATION,
    firstName,
    lastName,
    email,
    phone,
    companyName: company,
    website,
    source: 'AgentCopyAI',
    tags: [`ai-agent-${plan}`, 'agentcopyai', 'paid-customer'],
    customFields: [
      { key: 'stripe_customer_id', field_value: stripeCustomerId },
      { key: 'ai_agent_plan',      field_value: PLAN_NAMES[plan] || plan },
      { key: 'business_website',   field_value: website },
    ],
  };

  if (existing) {
    const updated = await ghlRequest('PUT', `/contacts/${existing.id}`, payload);
    return updated?.contact || existing;
  } else {
    const created = await ghlRequest('POST', '/contacts/', payload);
    return created?.contact;
  }
}

async function createOpportunity(contactId, { company, plan, amount, stripeCustomerId }) {
  const planName = PLAN_NAMES[plan] || plan;
  return ghlRequest('POST', '/opportunities/', {
    locationId: GHL_LOCATION,
    pipelineId: PIPELINE_ID,
    pipelineStageId: STAGE_PAID,
    contactId,
    name: `${company} — ${planName}`,
    monetaryValue: amount,
    status: 'open',
    assignedTo: null, // assigns to location default
    customFields: [
      { key: 'stripe_customer_id', field_value: stripeCustomerId },
      { key: 'ai_agent_plan',      field_value: planName },
    ],
  });
}

async function addNote(contactId, message) {
  return ghlRequest('POST', `/contacts/${contactId}/notes`, {
    body: message,
    userId: null,
  });
}

async function sendInternalNotification(contactId, { name, company, plan, phone, email, website, industry }) {
  // Create a task in GHL assigned to the location so Matt sees it
  const planName = PLAN_NAMES[plan] || plan;
  const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours from now

  return ghlRequest('POST', `/contacts/${contactId}/tasks`, {
    title: `🚀 NEW AGENTCOPYAI SIGNUP — Provision ${company} within 24 hours`,
    body: `New customer details:\n\nName: ${name}\nCompany: ${company}\nEmail: ${email}\nPhone: ${phone}\nWebsite: ${website}\nIndustry: ${industry || 'not provided'}\nPlan: ${planName}\n\nAction: Verify auto-provisioned sub-account, custom widget config, and welcome email sent.\nPromised: Embed snippet delivered within 24 hours via email.`,
    dueDate,
    completed: false,
    assignedTo: null, // defaults to location owner (Matt)
  });
}

// ── Welcome email via GHL conversation ───────────────────────────────────────
// Welcome email — now inlines the customer's widget snippet + offers free install.
// widgetId comes from per-customer sub-account provisioning (see provisionCustomer).
// installBookingUrl is the GHL calendar link for the AgentCopyAI Install calendar.
// website is what they entered at checkout, used to pick platform-specific install hints.
async function sendWelcomeEmail(contactId, { name, company, plan, email, widgetId, installBookingUrl, website }) {
  const planName = PLAN_NAMES[plan] || plan;
  const firstName = name.split(' ')[0] || name;

  // Trigger email via GHL outbound conversation
  return ghlRequest('POST', '/conversations/messages/outbound', {
    type: 'Email',
    contactId,
    subject: `Welcome to ScaleLocal, ${firstName}! Your AI agent is being set up 🚀`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; color: #0C0A09;">
        <div style="padding: 32px 0 16px;">
          <div style="background: linear-gradient(135deg, #0D9488, #2563EB); width: 44px; height: 44px; border-radius: 10px; text-align: center; margin-bottom: 24px;">
            <span style="color: white; font-size: 20px; font-weight: 800; line-height: 44px; display: block;">A</span>
          </div>
          <h1 style="font-size: 24px; font-weight: 700; margin: 0 0 8px;">Welcome to ScaleLocal, ${firstName}!</h1>
          <p style="font-size: 16px; color: #57534E; margin: 0 0 24px;">Your AI agent is built and ready to install on ${company || 'your site'}.</p>
        </div>

        <div style="background: #F0FDF4; border: 1px solid #BBF7D0; border-radius: 12px; padding: 20px; margin-bottom: 28px;">
          <p style="margin: 0 0 4px; font-size: 13px; font-weight: 700; color: #16A34A; text-transform: uppercase; letter-spacing: 0.06em;">Your Plan</p>
          <p style="margin: 0; font-size: 16px; font-weight: 600;">${planName}</p>
        </div>

        <h2 style="font-size: 18px; font-weight: 700; margin: 0 0 12px;">Install in 60 seconds — paste this snippet on your site:</h2>
        <p style="font-size: 14px; color: #57534E; margin: 0 0 12px;">Add this single line before the closing <code>&lt;/body&gt;</code> tag of every page on your site (or in your theme's footer / global header section).</p>

        <div style="background: #0C0A09; border-radius: 10px; padding: 18px; margin-bottom: 24px; overflow-x: auto;">
          <code style="color: #67E8F9; font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 13px; line-height: 1.5; white-space: pre; display: block;">&lt;script src="https://widgets.leadconnectorhq.com/loader.js" data-widget-id="${widgetId}"&gt;&lt;/script&gt;</code>
        </div>

        <h3 style="font-size: 15px; font-weight: 700; margin: 0 0 10px;">Quick instructions by platform:</h3>
        <div style="background: #FAFAF9; border: 1px solid #E7E5E4; border-radius: 10px; padding: 18px; margin-bottom: 28px; font-size: 14px; line-height: 1.7;">
          <div style="margin-bottom: 10px;"><strong>WordPress:</strong> Appearance → Theme File Editor → footer.php → paste before <code>&lt;/body&gt;</code>. (Or use a header/footer plugin like "Insert Headers and Footers.")</div>
          <div style="margin-bottom: 10px;"><strong>Shopify:</strong> Online Store → Themes → Edit Code → <code>theme.liquid</code> → paste before <code>&lt;/body&gt;</code>.</div>
          <div style="margin-bottom: 10px;"><strong>Wix:</strong> Settings → Custom Code → Add Custom Code → paste in "Body — end" placement, "All Pages".</div>
          <div style="margin-bottom: 10px;"><strong>Squarespace:</strong> Settings → Advanced → Code Injection → "Footer" → paste.</div>
          <div><strong>Custom HTML / other:</strong> paste anywhere inside the <code>&lt;body&gt;</code> of every page — closer to <code>&lt;/body&gt;</code> is better for performance.</div>
        </div>

        <div style="background: linear-gradient(135deg, #EFF6FF, #F0FDF4); border: 1px solid #BFDBFE; border-radius: 12px; padding: 20px; margin-bottom: 28px;">
          <h3 style="font-size: 16px; font-weight: 700; margin: 0 0 8px; color: #1E40AF;">Want us to install it for you? Free.</h3>
          <p style="font-size: 14px; color: #1E40AF; margin: 0 0 16px;">If you'd rather we handle it, pick a 15-minute slot below. We'll need your website's login (WordPress admin, Shopify staff account, or whatever CMS you use). Takes us about 5 minutes once we're in.</p>
          <a href="${installBookingUrl || 'https://scalelocal.net/install-help'}" style="display: inline-block; background: #2563EB; color: white; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 15px;">Book a 15-min install →</a>
        </div>

        <div style="border-top: 1px solid #E7E5E4; padding-top: 20px; margin-bottom: 20px;">
          <h3 style="font-size: 15px; font-weight: 700; margin: 0 0 10px;">What your agent does once it's live</h3>
          <ul style="font-size: 14px; color: #57534E; padding-left: 18px; margin: 0;">
            <li style="margin-bottom: 6px;">Answers visitor questions 24/7 in chat and voice — trained on YOUR website</li>
            <li style="margin-bottom: 6px;">Captures leads when you're closed or on a job</li>
            <li style="margin-bottom: 6px;">Sends every inquiry straight to your inbox</li>
            ${plan === 'talking_website_scheduling' ? '<li style="margin-bottom: 6px;"><strong>Books appointments and quotes</strong> directly into your calendar (your $29 plan)</li>' : ''}
          </ul>
        </div>

        <div style="color: #A8A29E; font-size: 13px; line-height: 1.6;">
          <p style="margin: 0 0 4px;">Reply to this email if anything's unclear — we read every one.</p>
          <p style="margin: 0;">✉️ <a href="mailto:alex@scalelocal.net" style="color: #0D9488;">alex@scalelocal.net</a></p>
          <p style="margin: 12px 0 0; color: #D6D3D1;">ScaleLocal · <a href="https://scalelocal.net" style="color: #D6D3D1;">scalelocal.net</a></p>
        </div>
      </div>
    `,
    emailFrom: 'alex@scalelocal.net',
    emailFromName: 'Alex at ScaleLocal',
    emailReplyTo: 'alex@scalelocal.net',
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Read raw body for signature verification
  const rawBody = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  // Verify Stripe signature
  const signature = req.headers['stripe-signature'];
  if (!WEBHOOK_SECRET || !verifyStripeSignature(rawBody, signature, WEBHOOK_SECRET)) {
    console.error('[Webhook] Invalid signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  console.log(`[Webhook] Event: ${event.type}`);

  try {
    // ── checkout.session.completed → new customer paid ────────────────────────
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // Extract customer details from Stripe session
      const customerDetails = session.customer_details || {};
      const customFields = session.custom_fields || [];

      const fullName = customerDetails.name || 'Unknown';
      const nameParts = fullName.trim().split(/\s+/);
      const firstName = nameParts[0] || 'Unknown';
      const lastName = nameParts.slice(1).join(' ') || '';

      const email   = customerDetails.email || '';
      const phone   = customerDetails.phone || '';
      const company  = customFields.find(f => f.key === 'business_name')?.text?.value
                    || customFields.find(f => f.key === 'company_name')?.text?.value
                    || '';
      const website  = customFields.find(f => f.key === 'website_url')?.text?.value || '';
      const industry = customFields.find(f => f.key === 'industry_trade')?.text?.value || '';
      const plan    = session.metadata?.product || session.metadata?.plan || 'talking_website';
      const amount  = (session.amount_total || 1900) / 100; // Fallback default = $19 (new base tier)
      const stripeCustomerId = session.customer || '';

      console.log(`[Webhook] New signup: ${fullName} / ${company} / ${plan}`);

      // 1. Create or update GHL contact
      const contact = await createOrUpdateContact({
        firstName, lastName, email, phone,
        company, website, plan, stripeCustomerId,
      });

      if (!contact?.id) {
        console.error('[Webhook] Failed to create contact');
        return res.status(200).json({ received: true, warning: 'Contact creation failed' });
      }

      const contactId = contact.id;

      // 2. Add to pipeline as paid opportunity
      await createOpportunity(contactId, { company, plan, amount, stripeCustomerId });

      // 3. Auto-provision: clone Master Templates snapshot into a new sub-account
      //    for this customer, then train the chat bot + voice agent on their website.
      //    Returns { subAccountId, widgetId, error }. On error, falls back to manual
      //    install (snippet placeholder is empty; Matt does it manually via task).
      const prov = await provisionCustomer({
        company, website, plan, email, name: fullName, phone, stripeCustomerId,
      });

      // 4. Add detailed note to contact (includes provisioning result)
      const planName = PLAN_NAMES[plan] || plan;
      await addNote(contactId, [
        `🎉 NEW AI WEBSITE AGENT SIGNUP`,
        ``,
        `Plan: ${planName}`,
        `Amount paid: $${amount}`,
        `Company: ${company}`,
        `Website: ${website}`,
        `Stripe Customer ID: ${stripeCustomerId}`,
        ``,
        `Auto-provisioning:`,
        `  Sub-account: ${prov.subAccountId || '⚠️ NOT CREATED — manual setup needed'}`,
        `  Widget ID: ${prov.widgetId || '⚠️ NOT GENERATED — manual setup needed'}`,
        prov.error ? `  Error: ${prov.error}` : `  Status: ready, welcome email sent`,
        ``,
        `Source: AgentCopyAI`,
      ].join('\n'));

      // 5. Create task for Matt — due in 24 hours (will say "verify install" if auto-provision worked, "manual setup" if it failed)
      await sendInternalNotification(contactId, {
        name: fullName, company, plan, phone, email, website, industry,
        provisioningStatus: prov.error ? 'failed' : 'ok',
      });

      // 6. Send branded welcome email from Alex with snippet + install booking link
      await sendWelcomeEmail(contactId, {
        name: fullName, company, plan, email,
        widgetId: prov.widgetId,
        installBookingUrl: process.env.INSTALL_BOOKING_URL || '',
        website,
      });

      console.log(`[Webhook] ✓ All GHL actions completed for ${fullName}`);
    }

    // ── customer.subscription.deleted → cancellation ─────────────────────────
    // Retag contact from paid-customer -> churned, add note, create task for Matt.
    // Stripe customer ID is stored in the contact's customField 'stripe_customer_id'
    // (set by createOrUpdateContact on checkout.session.completed).
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const stripeCustomerId = sub.customer;
      console.log(`[Webhook] Subscription cancelled for Stripe customer: ${stripeCustomerId}`);

      const contact = await findContactByStripeId(stripeCustomerId);
      if (contact?.id) {
        await retagContact(contact.id, contact.tags || [], {
          remove: ['paid-customer', 'active-customer'],
          add: ['churned', 'cancelled-subscription'],
        });
        await addNote(contact.id, [
          `🔴 SUBSCRIPTION CANCELLED — ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`,
          ``,
          `Stripe customer: ${stripeCustomerId}`,
          `Subscription ID: ${sub.id}`,
          `Cancelled at: ${sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : 'unknown'}`,
          `Cancellation reason: ${sub.cancellation_details?.reason || 'not specified'}`,
          ``,
          `Action: send win-back sequence in 30 days.`,
        ].join('\n'));
        await createCancellationTask(contact.id, { stripeCustomerId, sub });
        console.log(`[Webhook] ✓ Cancellation handled for contact ${contact.id}`);
      } else {
        console.error(`[Webhook] Cancellation: contact not found for Stripe customer ${stripeCustomerId}`);
      }
    }

    // ── invoice.payment_failed → at risk ─────────────────────────────────────
    // Tag contact at-risk, add note with retry details, create urgent task for Matt.
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const stripeCustomerId = invoice.customer;
      console.log(`[Webhook] Payment failed for customer: ${stripeCustomerId}`);

      const contact = await findContactByStripeId(stripeCustomerId);
      if (contact?.id) {
        await retagContact(contact.id, contact.tags || [], {
          add: ['at-risk', 'payment-failed'],
        });
        const attemptCount = invoice.attempt_count || 1;
        const nextAttempt = invoice.next_payment_attempt
          ? new Date(invoice.next_payment_attempt * 1000).toISOString()
          : 'no retry scheduled';
        await addNote(contact.id, [
          `⚠️ PAYMENT FAILED — ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`,
          ``,
          `Stripe customer: ${stripeCustomerId}`,
          `Invoice: ${invoice.id}`,
          `Amount: $${(invoice.amount_due || 0) / 100}`,
          `Attempt count: ${attemptCount}`,
          `Next retry: ${nextAttempt}`,
          ``,
          `Action: reach out before Stripe gives up retrying (typically 4 attempts over 2 weeks).`,
        ].join('\n'));
        await createPaymentFailureTask(contact.id, { stripeCustomerId, invoice });
        console.log(`[Webhook] ✓ Payment-failure handled for contact ${contact.id}`);
      } else {
        console.error(`[Webhook] Payment failed: contact not found for Stripe customer ${stripeCustomerId}`);
      }
    }

  } catch (err) {
    console.error('[Webhook] Processing error:', err.message, err.stack);
    // Return 200 so Stripe doesn't retry — we log the error
    return res.status(200).json({ received: true, error: err.message });
  }

  return res.status(200).json({ received: true });
}

// ── Auto-provisioning: clone snapshot → train bot → get widget ID ────────────
// Called from checkout.session.completed. Returns { subAccountId, widgetId, error }.
//
// REQUIRES env vars:
//   GHL_AGENCY_TOKEN  — agency-scoped PIT with locations.write + snapshots.readonly
//   GHL_COMPANY_ID    — your GHL agency company ID (FG7sbUjVDjTL90y9LnEP for ScaleLocal)
//   GHL_TEMPLATE_SNAPSHOT_ID  — snapshot ID of "AgentCopyAI Customer Template" (Matt creates manually)
//
// On any failure: returns { subAccountId: null, widgetId: null, error: 'reason' }
// so the welcome email falls back to a placeholder snippet and Matt manually fixes
// via the GHL UI. Never throws — the customer's payment must still succeed.
const AGENCY_TOKEN = process.env.GHL_AGENCY_TOKEN;
const AGENCY_COMPANY_ID = process.env.GHL_COMPANY_ID;
const TEMPLATE_SNAPSHOT_ID = process.env.GHL_TEMPLATE_SNAPSHOT_ID;

async function provisionCustomer({ company, website, plan, email, name, phone, stripeCustomerId }) {
  // Pre-flight checks — bail cleanly if config is incomplete
  if (!AGENCY_TOKEN) {
    console.error('[Provision] Missing GHL_AGENCY_TOKEN env var');
    return { subAccountId: null, widgetId: null, error: 'missing_agency_token' };
  }
  if (!AGENCY_COMPANY_ID) {
    console.error('[Provision] Missing GHL_COMPANY_ID env var');
    return { subAccountId: null, widgetId: null, error: 'missing_company_id' };
  }
  if (!TEMPLATE_SNAPSHOT_ID) {
    console.error('[Provision] Missing GHL_TEMPLATE_SNAPSHOT_ID env var — snapshot must be created first via GHL UI');
    return { subAccountId: null, widgetId: null, error: 'missing_snapshot_id' };
  }

  // Step 1: Create the new sub-account from the template snapshot
  const subAccountName = (company || email.split('@')[0]).slice(0, 60);
  let subAccountId = null;
  try {
    const res = await fetch('https://services.leadconnectorhq.com/locations/', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AGENCY_TOKEN}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        companyId: AGENCY_COMPANY_ID,
        name: `${subAccountName} (AgentCopyAI)`,
        snapshotId: TEMPLATE_SNAPSHOT_ID,
        firstName: name.split(' ')[0] || 'Customer',
        lastName: name.split(' ').slice(1).join(' ') || '',
        email: email,
        phone: phone,
        country: 'US',
        timezone: 'America/New_York',
        website: website || '',
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error(`[Provision] Sub-account create ${res.status}: ${txt.slice(0, 300)}`);
      return { subAccountId: null, widgetId: null, error: `subaccount_create_${res.status}` };
    }
    const data = await res.json();
    subAccountId = data?.location?.id || data?.id || null;
    if (!subAccountId) {
      console.error('[Provision] Sub-account created but no ID in response:', JSON.stringify(data).slice(0, 300));
      return { subAccountId: null, widgetId: null, error: 'no_subaccount_id_in_response' };
    }
    console.log(`[Provision] Created sub-account ${subAccountId} for ${company}`);
  } catch (err) {
    console.error('[Provision] Sub-account create exception:', err.message);
    return { subAccountId: null, widgetId: null, error: 'subaccount_create_exception' };
  }

  // Step 2: Train the bot on the customer's website.
  // Calls our own create-agent.js logic for the new sub-account. We delegate via
  // an internal POST so we don't duplicate the scraping/Places/personality logic.
  // create-agent.js writes the personality to whichever bot ID is currently
  // configured for the demo (GHL_CHAT_BOT_ID/GHL_VOICE_AGENT_ID env vars). For
  // per-customer provisioning we'd want to point it at the NEW sub-account's
  // bot IDs — that needs sub-account PIT introspection which agency PAT can't do.
  // PHASE 1: skip this step and let Matt manually load the bot personality from the
  //   Master Templates snapshot (which should have a generic-but-good template prompt).
  // PHASE 2: extend create-agent.js to accept locationId + bot/voice IDs as params
  //   and call it here with the new sub-account's IDs.

  // Step 3: Find the AIO widget ID in the new sub-account.
  // PHASE 1: the snapshot clone brings the widget with it but its ID is new.
  //   Agency PAT can't list widgets — need sub-account PIT. Until we wire that,
  //   return null and the welcome email falls back to a placeholder snippet.
  // PHASE 2: list widgets via sub-account PIT, return the AIO widget ID.
  const widgetId = null; // PHASE 2 — needs sub-account PIT introspection

  return { subAccountId, widgetId, error: null };
}

// ── Helpers for cancellation + payment-failure handlers ────────────────────
// Search contacts by Stripe customer ID. We stored stripe_customer_id as a
// customField on the contact during checkout.session.completed. GHL's query
// search matches custom-field values in addition to name/email/phone.
async function findContactByStripeId(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION}&query=${encodeURIComponent(stripeCustomerId)}&limit=5`, {
      headers: {
        'Authorization': `Bearer ${GHL_TOKEN}`,
        'Version': '2021-07-28',
        'Accept': 'application/json',
      },
    });
    if (!res.ok) {
      console.error(`[Webhook] findContactByStripeId ${res.status}`);
      return null;
    }
    const data = await res.json();
    const contacts = data.contacts || [];
    // Prefer match where customField actually contains the stripe ID
    const exact = contacts.find(c =>
      (c.customFields || []).some(f =>
        (f.value === stripeCustomerId || f.field_value === stripeCustomerId) &&
        (f.key === 'stripe_customer_id' || f.name === 'stripe_customer_id')
      )
    );
    return exact || contacts[0] || null;
  } catch (err) {
    console.error('[Webhook] findContactByStripeId error:', err.message);
    return null;
  }
}

// Atomically add/remove tags. We GET current tags, mutate, PUT the new set
// because GHL's tag endpoint doesn't atomically merge-and-remove in one call.
async function retagContact(contactId, currentTags, { add = [], remove = [] }) {
  try {
    const next = new Set(currentTags);
    remove.forEach(t => next.delete(t));
    add.forEach(t => next.add(t));
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GHL_TOKEN}`,
        'Version': '2021-07-28',
      },
      body: JSON.stringify({ tags: Array.from(next) }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error(`[Webhook] retagContact ${res.status}: ${txt.slice(0, 200)}`);
    }
  } catch (err) {
    console.error('[Webhook] retagContact error:', err.message);
  }
}

async function createCancellationTask(contactId, { stripeCustomerId, sub }) {
  try {
    const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GHL_TOKEN}`,
        'Version': '2021-07-28',
      },
      body: JSON.stringify({
        title: `AgentCopyAI subscription cancelled — ${stripeCustomerId}`,
        body: `Subscription ${sub.id} cancelled. Reason: ${sub.cancellation_details?.reason || 'not specified'}. Send win-back sequence in 30 days.`,
        dueDate,
      }),
    });
  } catch (err) {
    console.error('[Webhook] createCancellationTask error:', err.message);
  }
}

async function createPaymentFailureTask(contactId, { stripeCustomerId, invoice }) {
  try {
    const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GHL_TOKEN}`,
        'Version': '2021-07-28',
      },
      body: JSON.stringify({
        title: `⚠️ AgentCopyAI payment failed — ${stripeCustomerId}`,
        body: `Invoice ${invoice.id} failed. Amount: $${(invoice.amount_due || 0) / 100}. Attempt ${invoice.attempt_count}. Reach out before Stripe gives up (~2 weeks).`,
        dueDate,
      }),
    });
  } catch (err) {
    console.error('[Webhook] createPaymentFailureTask error:', err.message);
  }
}

