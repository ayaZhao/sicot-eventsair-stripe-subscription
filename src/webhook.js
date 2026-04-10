import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import Stripe from 'stripe';
import { isCanceledRegistration, lookupMembershipContactsByEmail } from './eventsair-api.js';
import { buildSubscriptionItemsFromRegistrationTypes } from './registration-type-map.js';

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const port = Number(process.env.PORT || 3000);
const enableConsoleLogs = process.env.WEBHOOK_CONSOLE_LOGS !== 'false';

// Feature and billing defaults for the EventsAir membership renewal flow.
const createSubscriptions = process.env.CREATE_SUBSCRIPTIONS === 'true';
const defaultTaxRateId = process.env.STRIPE_DEFAULT_TAX_RATE_ID || null;
const checkoutArtifactWindowSeconds = 30 * 60;

// Free members complete a small temporary checkout so Stripe saves a reusable card.
// That checkout is refunded before the yearly subscription is created.
const freeMembershipCaptureAmountCents = 50;
const freeMembershipCaptureCurrency = 'eur';

// EventsAir can lag briefly before registrations appear after checkout completes.
// These values define how long the webhook waits and retries the email lookup.
const eventsAirLookupInitialDelayMs = 5 * 1000;
const eventsAirLookupRetryDelayMs = 10 * 1000;
const eventsAirLookupMaxAttempts = 6;

// Stripe can deliver the same webhook more than once, so we keep a small local
// processing state file and a timeout to prevent duplicate refund/subscription work.
const webhookEventLockTimeoutMs = 10 * 60 * 1000;
const webhookEventStatePath = process.env.WEBHOOK_EVENT_STATE_PATH
  || path.resolve(process.cwd(), '.runtime', 'processed-stripe-events.json');

// Webhook events are written both to stdout and to a local JSON-lines log file so
// test-mode runs can be reviewed before the same code is deployed to live.
const webhookLogPath = process.env.WEBHOOK_LOG_PATH
  || path.resolve(process.cwd(), 'logs', 'webhook.log');

function toIso(unixSeconds) {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}

function getNextRenewalJanuarySeventhUnix(referenceUnixSeconds) {
  const referenceDate = new Date(referenceUnixSeconds * 1000);
  const nextYear = referenceDate.getUTCFullYear() + 1;
  // SICOT asked for renewals to start at 12:00 noon Belgium time on 7 January.
  // Belgium is on CET (UTC+1) on 7 January, so we anchor the Stripe trial end at 11:00 UTC.
  return Math.floor(Date.UTC(nextYear, 0, 7, 11, 0, 0) / 1000);
}

async function loadWebhookEventState() {
  try {
    const file = await fs.readFile(webhookEventStatePath, 'utf8');
    return JSON.parse(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }

    throw error;
  }
}

async function saveWebhookEventState(state) {
  await fs.mkdir(path.dirname(webhookEventStatePath), { recursive: true });
  await fs.writeFile(webhookEventStatePath, JSON.stringify(state, null, 2));
}

async function appendWebhookLog(entry) {
  const logEntry = {
    logged_at_iso: new Date().toISOString(),
    ...entry,
  };

  await fs.mkdir(path.dirname(webhookLogPath), { recursive: true });
  await fs.appendFile(webhookLogPath, `${JSON.stringify(logEntry)}\n`);
}

async function logWebhookJson(payload) {
  if (enableConsoleLogs) {
    console.log(JSON.stringify(payload, null, 2));
  }
  await appendWebhookLog(payload);
}

async function logWebhookMessage(payload) {
  if (enableConsoleLogs) {
    console.log(payload.message);
  }
  await appendWebhookLog(payload);
}

async function logWebhookError(payload) {
  console.error(payload.message);
  await appendWebhookLog(payload);
}

async function beginWebhookEventProcessing(eventId) {
  // Mark the Stripe event as processing unless we have already completed it or
  // another request is still actively handling the same event id.
  const state = await loadWebhookEventState();
  const existing = state[eventId];
  const now = Date.now();

  if (existing && existing.status === 'completed') {
    return {
      should_process: false,
      reason: 'already-completed',
      entry: existing,
    };
  }

  if (
    existing
    && existing.status === 'processing'
    && typeof existing.started_at_unix_ms === 'number'
    && (now - existing.started_at_unix_ms) < webhookEventLockTimeoutMs
  ) {
    return {
      should_process: false,
      reason: 'already-processing',
      entry: existing,
    };
  }

  state[eventId] = {
    status: 'processing',
    started_at_unix_ms: now,
    started_at_iso: new Date(now).toISOString(),
  };
  await saveWebhookEventState(state);

  return {
    should_process: true,
    reason: 'started',
    entry: state[eventId],
  };
}

async function completeWebhookEventProcessing(eventId) {
  const state = await loadWebhookEventState();
  const existing = state[eventId] || {};
  const now = Date.now();

  state[eventId] = {
    ...existing,
    status: 'completed',
    completed_at_unix_ms: now,
    completed_at_iso: new Date(now).toISOString(),
  };
  await saveWebhookEventState(state);
}

async function releaseWebhookEventProcessing(eventId, errorMessage) {
  const state = await loadWebhookEventState();
  if (!state[eventId]) {
    return;
  }

  state[eventId] = {
    ...state[eventId],
    status: 'failed',
    failed_at_unix_ms: Date.now(),
    failed_at_iso: new Date().toISOString(),
    last_error: errorMessage,
  };
  await saveWebhookEventState(state);
}

function summarizeSubscription(subscription) {
  return {
    id: subscription.id,
    status: subscription.status,
    customer: subscription.customer,
    trial_end: subscription.trial_end,
    current_period_start: subscription.current_period_start,
    current_period_end: subscription.current_period_end,
    cancel_at_period_end: subscription.cancel_at_period_end,
    metadata: subscription.metadata,
    items: subscription.items.data.map((item) => ({
      subscription_item_id: item.id,
      price_id: item.price ? item.price.id : null,
      product_id: item.price ? item.price.product : null,
      interval: item.price && item.price.recurring ? item.price.recurring.interval : null,
      unit_amount: item.price ? item.price.unit_amount : null,
      currency: item.price ? item.price.currency : null,
      quantity: item.quantity,
    })),
  };
}

function summarizeRefund(refund) {
  if (!refund) {
    return null;
  }

  return {
    id: refund.id,
    payment_intent: refund.payment_intent,
    amount: refund.amount,
    currency: refund.currency,
    status: refund.status,
    reason: refund.reason || null,
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function buildStripeMetadata({ memberId, primaryMembershipType, addonMembershipTypes }) {
  return {
    source: 'eventsair',
    member_id: memberId != null ? String(memberId) : '',
    primary_membership_type: primaryMembershipType || '',
    addon_membership_types: JSON.stringify(Array.isArray(addonMembershipTypes) ? addonMembershipTypes : []),
  };
}

function summarizeEventsAirMatch(match) {
  if (!match) {
    return null;
  }

  return {
    source_kind: match.source_kind,
    event_id: match.event_id,
    event_name: match.event_name,
    member_id: match.contact ? match.contact.internalNumber : null,
    external_identifier: match.contact ? match.contact.externalIdentifier : null,
    primary_membership_type: match.primary_membership_type || null,
    addon_membership_types: match.addon_membership_types || [],
  };
}

function summarizeMappedSubscriptionItem(item) {
  return {
    role: item.role,
    type_name: item.type_name,
    source_type_name: item.source_type_name,
    price: item.price,
  };
}

function selectBestEventsAirMatch(eventsAirLookup) {
  const matches = eventsAirLookup && Array.isArray(eventsAirLookup.matches)
    ? eventsAirLookup.matches
    : [];

  return matches.find((match) => match.primary_membership_type) || matches[0] || null;
}

function hasRegistrationsReady(eventsAirLookup) {
  const selectedMatch = selectBestEventsAirMatch(eventsAirLookup);
  const registrations = selectedMatch
    && selectedMatch.contact
    && Array.isArray(selectedMatch.contact.registrations)
    ? selectedMatch.contact.registrations
    : [];

  return registrations.some((registration) => !isCanceledRegistration(registration));
}

async function lookupMembershipContactsByEmailWithRetry(email) {
  // The membership type is driven by EventsAir registrations, so we retry the
  // email lookup briefly until registrations are available or the retry window ends.
  const attempts = [];
  let lookup = null;
  let selectedMatch = null;
  let totalWaitedMs = 0;

  for (let attemptNumber = 1; attemptNumber <= eventsAirLookupMaxAttempts; attemptNumber += 1) {
    const waitBeforeAttemptMs = attemptNumber === 1
      ? eventsAirLookupInitialDelayMs
      : eventsAirLookupRetryDelayMs;

    await wait(waitBeforeAttemptMs);
    totalWaitedMs += waitBeforeAttemptMs;

    try {
      lookup = await lookupMembershipContactsByEmail(email);
      selectedMatch = selectBestEventsAirMatch(lookup);

      const registrations = selectedMatch
        && selectedMatch.contact
        && Array.isArray(selectedMatch.contact.registrations)
        ? selectedMatch.contact.registrations
        : [];

      attempts.push({
        attempt_number: attemptNumber,
        waited_ms_before_attempt: waitBeforeAttemptMs,
        found: Boolean(selectedMatch),
        total_matches: lookup && typeof lookup.total_matches === 'number' ? lookup.total_matches : 0,
        primary_membership_type: selectedMatch ? selectedMatch.primary_membership_type || null : null,
        registration_count: registrations.length,
      });

      if (hasRegistrationsReady(lookup)) {
        return {
          lookup,
          selected_match: selectedMatch,
          total_waited_ms: totalWaitedMs,
          attempts,
        };
      }
    } catch (error) {
      attempts.push({
        attempt_number: attemptNumber,
        waited_ms_before_attempt: waitBeforeAttemptMs,
        found: false,
        total_matches: 0,
        primary_membership_type: null,
        registration_count: 0,
        error: error.message,
      });
    }
  }

  return {
    lookup,
    selected_match: selectedMatch,
    total_waited_ms: totalWaitedMs,
    attempts,
  };
}

function isFreeUserRefundCandidate({ primaryMembershipType, addonMembershipTypes, session }) {
  // Free-user auto-refund only applies when EventsAir says the user has a primary
  // membership type, no addons, and the checkout total matches the fixed 0.50 EUR
  // temporary card-capture amount.
  const hasPrimaryMembership = Boolean(primaryMembershipType);
  const hasNoAddons = Array.isArray(addonMembershipTypes) && addonMembershipTypes.length === 0;
  const isCaptureAmountMatch = session
    && session.amount_total === freeMembershipCaptureAmountCents
    && String(session.currency || '').toLowerCase() === freeMembershipCaptureCurrency;

  return hasPrimaryMembership && hasNoAddons && isCaptureAmountMatch;
}

function isLikelyCheckoutArtifact(invoiceItem, session) {
  const itemTimestamp = invoiceItem.date || 0;
  const withinWindow = Math.abs(itemTimestamp - session.created) <= checkoutArtifactWindowSeconds;
  const sameAmount = typeof session.amount_total === 'number'
    ? invoiceItem.amount === session.amount_total
    : true;

  return withinWindow && sameAmount;
}

async function cleanupCheckoutBillingArtifacts({ customerId, session, pendingInvoiceItems, draftInvoices }) {
  const deletedPendingInvoiceItemIds = [];
  const deletedDraftInvoiceIds = [];

  // EventsAIR leaves draft invoice objects and pending invoice items behind after the
  // one-time payment succeeds. If we create a subscription immediately afterwards,
  // Stripe can collect those leftovers on the subscription's first invoice.
  for (const invoiceItem of pendingInvoiceItems) {
    if (!isLikelyCheckoutArtifact(invoiceItem, session)) {
      continue;
    }

    await stripe.invoiceItems.del(invoiceItem.id);
    deletedPendingInvoiceItemIds.push(invoiceItem.id);
  }

  for (const draftInvoice of draftInvoices) {
    const withinWindow = Math.abs(draftInvoice.created - session.created) <= checkoutArtifactWindowSeconds;
    const zeroBalanceDraft = (draftInvoice.amount_due || 0) === 0;
    if (!withinWindow || !zeroBalanceDraft || draftInvoice.customer !== customerId) {
      continue;
    }

    await stripe.invoices.del(draftInvoice.id);
    deletedDraftInvoiceIds.push(draftInvoice.id);
  }

  return {
    deleted_pending_invoice_item_ids: deletedPendingInvoiceItemIds,
    deleted_draft_invoice_ids: deletedDraftInvoiceIds,
  };
}

app.post('/api/eventsair/v1/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;

  try {
    // Verify the Stripe signature before touching the event payload.
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (error) {
    await logWebhookError({
      type: 'webhook-signature-error',
      message: `Webhook signature verification failed: ${error.message}`,
    });
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  try {
    // Skip duplicate deliveries of the same Stripe event as early as possible.
    const eventProcessingState = await beginWebhookEventProcessing(event.id);
    if (!eventProcessingState.should_process) {
      await logWebhookJson({
        event_type: event.type,
        stripe_event_id: event.id,
        note: `Webhook event skipped because it is ${eventProcessingState.reason}.`,
      });
      return res.json({ received: true, skipped: eventProcessingState.reason });
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const customerId = session.customer;
      if (!customerId) {
        await logWebhookMessage({
          type: 'webhook-skip',
          event_type: event.type,
          stripe_event_id: event.id,
          message: 'No customer found on checkout session',
        });
        await completeWebhookEventProcessing(event.id);
        return res.json({ received: true, skipped: 'no-customer' });
      }

      const customer = await stripe.customers.retrieve(customerId);
      const email = customer.email;
      // EventsAir registrations can lag slightly behind checkout completion, so the
      // member lookup retries for a short window before we decide what to do.
      const lookupResolution = await lookupMembershipContactsByEmailWithRetry(email);
      const eventsAirLookup = lookupResolution.lookup;
      const selectedEventsAirMatch = lookupResolution.selected_match;
      const eventsAirMemberId = selectedEventsAirMatch && selectedEventsAirMatch.contact
        ? selectedEventsAirMatch.contact.internalNumber
        : null;
      const primaryMembershipType = selectedEventsAirMatch ? selectedEventsAirMatch.primary_membership_type : null;
      const addonMembershipTypes = selectedEventsAirMatch ? selectedEventsAirMatch.addon_membership_types || [] : [];
      const hasNoFilteredRegistrationTypes = !primaryMembershipType && addonMembershipTypes.length === 0;

      // Registration types from EventsAir drive both the Stripe price mapping and the
      // decision about whether this checkout is a paid renewal or a free member capture.
      const subscriptionItemPreview = buildSubscriptionItemsFromRegistrationTypes({
        primaryMembershipType,
        addonMembershipTypes,
      });

      // Pull the current Stripe customer state up front so we can avoid duplicate
      // subscriptions and remove leftover one-time checkout billing artifacts.
      const paymentMethods = await stripe.paymentMethods.list({
        customer: customerId,
        type: 'card',
      });

      const existingSubscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 20,
      });

      const pendingInvoiceItems = await stripe.invoiceItems.list({
        customer: customerId,
        pending: true,
        limit: 100,
      });

      const draftInvoices = await stripe.invoices.list({
        customer: customerId,
        status: 'draft',
        limit: 20,
      });

      const openInvoices = await stripe.invoices.list({
        customer: customerId,
        status: 'open',
        limit: 20,
      });

      const hasExisting = existingSubscriptions.data.some((sub) =>
        ['active', 'trialing', 'past_due'].includes(sub.status),
      );

      const hasOpenInvoiceNeedingPayment = openInvoices.data.some(
        (invoice) => (invoice.amount_remaining || 0) > 0,
      );

      // Previous logic kept each subscription on a rolling 365-day cycle.
      // Renewals are now aligned to 7 January of the following calendar year at
      // 12:00 noon Belgium time for the EventsAir migration.
      // const trialEnd = session.created + 365 * 24 * 60 * 60;
      const trialEnd = getNextRenewalJanuarySeventhUnix(session.created);
      const defaultPaymentMethod = paymentMethods.data[0] || null;

      // Free members are modeled as a 0.50 EUR checkout with a primary membership type
      // and no addons. If matched, that temporary capture is refunded before we create
      // the yearly subscription.
      const isFreeUserFlow = isFreeUserRefundCandidate({
        primaryMembershipType,
        addonMembershipTypes,
        session,
      });
      const stripeMetadata = buildStripeMetadata({
        memberId: eventsAirMemberId,
        primaryMembershipType,
        addonMembershipTypes,
      });
      const subscriptionCreateParams = {
        customer: customerId,
        items: subscriptionItemPreview.items.map((item) => ({ price: item.price })),
        default_payment_method: defaultPaymentMethod ? defaultPaymentMethod.id : null,
        collection_method: 'charge_automatically',
        default_tax_rates: defaultTaxRateId ? [defaultTaxRateId] : undefined,
        payment_behavior: 'error_if_incomplete',
        trial_end: trialEnd,
        proration_behavior: 'none',
        metadata: stripeMetadata,
      };

      const debugResult = {
        event_type: event.type,
        stripe_event_id: event.id,
        checkout_session_id: session.id,
        checkout_created_iso: toIso(session.created),
        customer: {
          email,
          name: customer.name,
        },
        checkout_payment: {
          amount_total: session.amount_total,
          currency: session.currency || null,
        },
        eventsair_lookup: {
          found: Boolean(selectedEventsAirMatch),
          event_id: eventsAirLookup && eventsAirLookup.event_id ? eventsAirLookup.event_id : null,
          event_name: eventsAirLookup && eventsAirLookup.event_name ? eventsAirLookup.event_name : null,
          total_matches: eventsAirLookup && typeof eventsAirLookup.total_matches === 'number'
            ? eventsAirLookup.total_matches
            : 0,
          selected_match: summarizeEventsAirMatch(selectedEventsAirMatch),
          errors: eventsAirLookup && eventsAirLookup.errors ? eventsAirLookup.errors : null,
        },
        mapped_subscription_items: subscriptionItemPreview.items.map(summarizeMappedSubscriptionItem),
        missing_price_mappings: subscriptionItemPreview.missing_price_mappings,
      };

      let refundResult = null;
      const refundFreeUserCapture = async () => {
        if (!isFreeUserFlow || refundResult || !createSubscriptions) {
          return refundResult;
        }

        if (!session.payment_intent) {
          throw new Error('Free-user auto-refund is enabled, but checkout.session.completed did not include a payment_intent');
        }

        refundResult = await stripe.refunds.create(
          {
            payment_intent: session.payment_intent,
            reason: 'requested_by_customer',
            metadata: {
              source: 'eventsair-free-membership',
              checkout_session_id: session.id,
              customer_id: customerId,
              primary_membership_type: primaryMembershipType || '',
            },
          },
          {
            idempotencyKey: `eventsair-free-refund-${session.id}`,
          },
        );

        debugResult.refund_result = summarizeRefund(refundResult);
        return refundResult;
      };

      if (!selectedEventsAirMatch) {
        debugResult.note = 'No EventsAIR match found for this email. Subscription was not created.';
        await logWebhookJson(debugResult);
        await completeWebhookEventProcessing(event.id);
        return res.json({ received: true, skipped: 'no-eventsair-match' });
      }

      if (hasNoFilteredRegistrationTypes) {
        debugResult.note = 'No active EventsAIR registration types remained after filtering. Subscription was not created.';
        await logWebhookJson(debugResult);
        await completeWebhookEventProcessing(event.id);
        return res.json({ received: true, skipped: 'no-active-registration-types' });
      }

      if (!primaryMembershipType) {
        debugResult.note = 'No primary membership type found in EventsAIR registrations. Subscription was not created.';
        await logWebhookJson(debugResult);
        await completeWebhookEventProcessing(event.id);
        return res.json({ received: true, skipped: 'missing-primary-membership-type' });
      }

      if (isFreeUserFlow) {
        // Refund the temporary card-capture charge first so free users are not left
        // with a retained checkout payment if the rest of the flow succeeds.
        await refundFreeUserCapture();
      }

      if (subscriptionItemPreview.missing_price_mappings.length > 0) {
        debugResult.note = 'One or more registration types do not have Stripe price mappings. Subscription was not created.';
        await logWebhookJson(debugResult);
        await completeWebhookEventProcessing(event.id);
        return res.json({ received: true, skipped: 'missing-price-mapping' });
      }

      if (!defaultPaymentMethod || !defaultPaymentMethod.id) {
        debugResult.note = 'No saved payment method found. Subscription was not created.';
        await logWebhookJson(debugResult);
        await completeWebhookEventProcessing(event.id);
        return res.json({ received: true, skipped: 'no-payment-method' });
      }

      if (hasExisting) {
        debugResult.note = 'Existing subscription found. No new subscription was created.';
        await logWebhookJson(debugResult);
        await completeWebhookEventProcessing(event.id);
        return res.json({ received: true, skipped: 'existing-subscription' });
      }

      if (hasOpenInvoiceNeedingPayment) {
        debugResult.note = 'Open invoice requiring payment found. Subscription was not created to avoid an unexpected second charge.';
        await logWebhookJson(debugResult);
        await completeWebhookEventProcessing(event.id);
        return res.json({ received: true, skipped: 'open-invoice-needing-payment' });
      }

      if (!defaultTaxRateId) {
        debugResult.note = 'STRIPE_DEFAULT_TAX_RATE_ID is not configured. Subscription was not created because 21% VAT is required.';
        await logWebhookJson(debugResult);
        await completeWebhookEventProcessing(event.id);
        return res.json({ received: true, skipped: 'missing-tax-rate' });
      }

      if (!createSubscriptions) {
        debugResult.note = 'Preview mode only. No subscription created. Set CREATE_SUBSCRIPTIONS=true to enable creation.';
        await logWebhookJson(debugResult);
        await completeWebhookEventProcessing(event.id);
        return res.json({ received: true, preview: true });
      }

      await stripe.customers.update(customerId, {
        invoice_settings: {
          default_payment_method: defaultPaymentMethod.id,
        },
        metadata: {
          ...customer.metadata,
          source: 'eventsair',
          member_id: eventsAirMemberId != null ? String(eventsAirMemberId) : '',
        },
      });

      // Clear draft invoices and pending invoice items created by the initial checkout.
      // Otherwise Stripe can try to carry them onto the first subscription invoice.
      await cleanupCheckoutBillingArtifacts({
        customerId,
        session,
        pendingInvoiceItems: pendingInvoiceItems.data,
        draftInvoices: draftInvoices.data,
      });

      // Both paid users and free users end up with the same yearly renewal subscription.
      // The only difference is that free users already had the temporary checkout charge refunded.
      const createdSubscription = await stripe.subscriptions.create(
        subscriptionCreateParams,
        {
          idempotencyKey: `eventsair-subscription-${session.id}`,
        },
      );

      debugResult.note = isFreeUserFlow
        ? 'Subscription created successfully and the temporary 0.50 EUR free-user charge was refunded.'
        : 'Subscription created successfully.';
      debugResult.created_subscription = summarizeSubscription(createdSubscription);
      debugResult.refund_result = summarizeRefund(refundResult);
      await logWebhookJson(debugResult);
      await completeWebhookEventProcessing(event.id);
    }

    await completeWebhookEventProcessing(event.id);
    return res.json({ received: true });
  } catch (error) {
    if (event && event.id) {
      await releaseWebhookEventProcessing(event.id, error.message);
    }
    await logWebhookError({
      type: 'webhook-handler-error',
      event_type: event ? event.type : null,
      stripe_event_id: event ? event.id : null,
      message: `Webhook handling failed: ${error.message}`,
      stack: error.stack || null,
    });
    return res.status(500).json({ error: error.message });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  if (enableConsoleLogs) {
    console.log(`Webhook server listening on http://localhost:${port}`);
    console.log(`CREATE_SUBSCRIPTIONS=${createSubscriptions}`);
  }
  void appendWebhookLog({
    type: 'webhook-server-start',
    message: `Webhook server listening on http://localhost:${port}`,
    create_subscriptions: createSubscriptions,
    webhook_console_logs: enableConsoleLogs,
    webhook_log_path: webhookLogPath,
    webhook_event_state_path: webhookEventStatePath,
  });
});
