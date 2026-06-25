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
async function sendWelcomeEmail(contactId, { name, company, plan, email }) {
  const planName = PLAN_NAMES[plan] || plan;
  const firstName = name.split(' ')[0] || name;

  // Trigger email via GHL outbound conversation
  return ghlRequest('POST', '/conversations/messages/outbound', {
    type: 'Email',
    contactId,
    subject: `Welcome to ScaleLocal, ${firstName}! Your AI agent is being set up 🚀`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #0C0A09;">
        <div style="padding: 32px 0 16px;">
          <div style="background: linear-gradient(135deg, #0D9488, #2563EB); width: 44px; height: 44px; border-radius: 10px; display: flex; align-items: center; justify-content: center; margin-bottom: 24px;">
            <span style="color: white; font-size: 20px; font-weight: 800; line-height: 44px; display: block; text-align: center;">A</span>
          </div>
          <h1 style="font-size: 24px; font-weight: 700; margin: 0 0 8px;">Welcome to ScaleLocal, ${firstName}!</h1>
          <p style="font-size: 16px; color: #57534E; margin: 0 0 24px;">Your payment is confirmed and your AI agent is being configured right now.</p>
        </div>

        <div style="background: #F0FDF4; border: 1px solid #BBF7D0; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
          <p style="margin: 0 0 4px; font-size: 13px; font-weight: 700; color: #16A34A; text-transform: uppercase; letter-spacing: 0.06em;">Your Plan</p>
          <p style="margin: 0; font-size: 16px; font-weight: 600; color: #0C0A09;">${planName}</p>
        </div>

        <div style="margin-bottom: 28px;">
          <h2 style="font-size: 16px; font-weight: 700; margin: 0 0 16px;">What happens next</h2>
          <div style="display: flex; gap: 12px; margin-bottom: 14px; align-items: flex-start;">
            <div style="width: 28px; height: 28px; border-radius: 50%; background: #F0FDF4; border: 1px solid #BBF7D0; text-align: center; line-height: 28px; font-size: 13px; flex-shrink: 0;">✓</div>
            <div><strong>Payment confirmed</strong> — receipt sent to ${email}</div>
          </div>
          <div style="display: flex; gap: 12px; margin-bottom: 14px; align-items: flex-start;">
            <div style="width: 28px; height: 28px; border-radius: 50%; background: #EFF6FF; border: 1px solid #BFDBFE; text-align: center; line-height: 28px; font-size: 13px; flex-shrink: 0;">📞</div>
            <div><strong>You'll get an email within 24 hours</strong> with your custom widget snippet — paste it onto your site and you're live (we can install it for you if you'd rather; just reply)</div>
          </div>
          <div style="display: flex; gap: 12px; margin-bottom: 14px; align-items: flex-start;">
            <div style="width: 28px; height: 28px; border-radius: 50%; background: #EFF6FF; border: 1px solid #BFDBFE; text-align: center; line-height: 28px; font-size: 13px; flex-shrink: 0;">🤖</div>
            <div><strong>Your AI agent goes live</strong> — one snippet added to your site, then it answers customers 24/7 automatically</div>
          </div>
        </div>

        <div style="border-top: 1px solid #E7E5E4; padding-top: 24px; margin-bottom: 24px;">
          <p style="font-size: 15px; color: #57534E; margin: 0 0 16px;">
            While you wait — take a look at everything else ScaleLocal offers for local businesses:
          </p>
          <a href="https://scalelocal.net" style="display: inline-block; background: #0C0A09; color: white; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 15px;">
            Explore ScaleLocal →
          </a>
        </div>

        <div style="color: #A8A29E; font-size: 13px; line-height: 1.6;">
          <p style="margin: 0 0 4px;">Questions? We're here.</p>
          <p style="margin: 0;">📞 <a href="tel:+16173948707" style="color: #0D9488;">617.394.8707</a> &nbsp;·&nbsp; ✉️ <a href="mailto:alex@scalelocal.net" style="color: #0D9488;">alex@scalelocal.net</a></p>
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

      // 3. Add detailed note to contact
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
        `Action required: Verify auto-provisioned sub-account and confirm welcome email landed within 24 hours.`,
        `Source: AgentCopyAI`,
      ].join('\n'));

      // 4. Create task for Matt — due in 24 hours
      await sendInternalNotification(contactId, {
        name: fullName, company, plan, phone, email, website, industry,
      });

      // 5. Send branded welcome email from Alex
      await sendWelcomeEmail(contactId, {
        name: fullName, company, plan, email,
      });

      console.log(`[Webhook] ✓ All GHL actions completed for ${fullName}`);
    }

    // ── customer.subscription.deleted → cancellation ─────────────────────────
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const stripeCustomerId = sub.customer;

      // Find contact by Stripe customer ID tag/note — search by metadata
      // GHL doesn't have a direct Stripe ID lookup, so we search broadly
      // and match — this is best-effort
      console.log(`[Webhook] Subscription cancelled for Stripe customer: ${stripeCustomerId}`);
      // Future: query contacts with stripe_customer_id custom field
      // For now, log for manual follow-up
    }

    // ── invoice.payment_failed → at risk ─────────────────────────────────────
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      console.log(`[Webhook] Payment failed for customer: ${invoice.customer}`);
      // Future: move opportunity to "At Risk" stage, create task
    }

  } catch (err) {
    console.error('[Webhook] Processing error:', err.message, err.stack);
    // Return 200 so Stripe doesn't retry — we log the error
    return res.status(200).json({ received: true, error: err.message });
  }

  return res.status(200).json({ received: true });
}
