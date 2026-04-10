import 'dotenv/config';
import Stripe from 'stripe';
import { lookupMembershipContactsByEmailAcrossEvents } from '../src/eventsair-api.js';
import {
  buildSubscriptionItemsFromRegistrationTypes,
} from '../src/registration-type-map.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const email = process.argv[2];
const defaultTaxRateId = process.env.STRIPE_DEFAULT_TAX_RATE_ID || null;
const createSubscriptions = process.env.CREATE_SUBSCRIPTIONS === 'true';
const checkoutArtifactWindowSeconds = 30 * 60;

if (!email) {
  console.error('Usage: npm run check:customer -- user@example.com');
  process.exit(1);
}

function summarizeSubscription(subscription) {
  return {
    id: subscription.id,
    status: subscription.status,
    trial_end: subscription.trial_end,
    current_period_start: subscription.current_period_start,
    current_period_end: subscription.current_period_end,
    metadata: subscription.metadata,
    items: subscription.items.data.map((item) => ({
      price_id: item.price ? item.price.id : null,
      interval: item.price && item.price.recurring ? item.price.recurring.interval : null,
      unit_amount: item.price ? item.price.unit_amount : null,
      currency: item.price ? item.price.currency : null,
    })),
  };
}

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

function summarizePaymentMethod(paymentMethod) {
  if (!paymentMethod) {
    return null;
  }

  return {
    id: paymentMethod.id,
    type: paymentMethod.type,
    brand: paymentMethod.card ? paymentMethod.card.brand : null,
    last4: paymentMethod.card ? paymentMethod.card.last4 : null,
    exp_month: paymentMethod.card ? paymentMethod.card.exp_month : null,
    exp_year: paymentMethod.card ? paymentMethod.card.exp_year : null,
  };
}

function summarizeInvoice(invoice) {
  return {
    id: invoice.id,
    status: invoice.status,
    billing_reason: invoice.billing_reason,
    total: invoice.total,
    amount_due: invoice.amount_due,
    amount_remaining: invoice.amount_remaining,
    created_iso: toIso(invoice.created),
  };
}

function summarizeInvoiceItem(invoiceItem) {
  return {
    id: invoiceItem.id,
    amount: invoiceItem.amount,
    description: invoiceItem.description,
    invoice: invoiceItem.invoice,
    date_iso: toIso(invoiceItem.date),
  };
}

function isLikelyCheckoutArtifact(invoiceItem, referenceTimestamp, referenceAmount) {
  const itemTimestamp = invoiceItem.date || 0;
  const withinWindow = Math.abs(itemTimestamp - referenceTimestamp) <= checkoutArtifactWindowSeconds;
  const sameAmount = typeof referenceAmount === 'number'
    ? invoiceItem.amount === referenceAmount
    : true;

  return withinWindow && sameAmount;
}

async function cleanupCheckoutBillingArtifacts({
  customerId,
  pendingInvoiceItems,
  draftInvoices,
  referenceTimestamp,
  referenceAmount,
}) {
  const deletedPendingInvoiceItemIds = [];
  const deletedDraftInvoiceIds = [];

  for (const invoiceItem of pendingInvoiceItems) {
    if (!isLikelyCheckoutArtifact(invoiceItem, referenceTimestamp, referenceAmount)) {
      continue;
    }

    await stripe.invoiceItems.del(invoiceItem.id);
    deletedPendingInvoiceItemIds.push(invoiceItem.id);
  }

  for (const draftInvoice of draftInvoices) {
    const withinWindow = Math.abs(draftInvoice.created - referenceTimestamp) <= checkoutArtifactWindowSeconds;
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

function buildStripeMetadata({ primaryMembershipType, addonMembershipTypes }) {
  return {
    source: 'eventsair',
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
    registrations: (match.contact && Array.isArray(match.contact.registrations)
      ? match.contact.registrations
      : []).map((registration) => ({
        id: registration.id,
        type_id: registration.type ? registration.type.id : null,
        type_name: registration.type ? registration.type.name : null,
      })),
  };
}

function selectBestEventsAirMatch(eventsAirLookup) {
  const matches = eventsAirLookup && Array.isArray(eventsAirLookup.matches)
    ? eventsAirLookup.matches
    : [];

  return matches.find((match) => match.primary_membership_type) || matches[0] || null;
}

async function main() {
  // Use the most recent customer with this email and mirror the webhook's
  // create-or-skip decision without changing any Stripe data.
  const customers = await stripe.customers.list({ email, limit: 10 });

  if (!customers.data.length) {
    console.log(`No Stripe customer found for email: ${email}`);
    return;
  }

  const customer = customers.data[0];
  const paymentMethods = await stripe.paymentMethods.list({
    customer: customer.id,
    type: 'card',
  });

  const existingSubscriptions = await stripe.subscriptions.list({
    customer: customer.id,
    status: 'all',
    limit: 20,
  });

  const pendingInvoiceItems = await stripe.invoiceItems.list({
    customer: customer.id,
    pending: true,
    limit: 100,
  });

  const draftInvoices = await stripe.invoices.list({
    customer: customer.id,
    status: 'draft',
    limit: 20,
  });

  const openInvoices = await stripe.invoices.list({
    customer: customer.id,
    status: 'open',
    limit: 20,
  });

  const charges = await stripe.charges.list({
    customer: customer.id,
    limit: 20,
  });

  let eventsAirLookup = null;
  try {
    eventsAirLookup = await lookupMembershipContactsByEmailAcrossEvents(email);
  } catch (error) {
    eventsAirLookup = {
      found: false,
      error: error.message,
    };
  }

  const selectedEventsAirMatch = selectBestEventsAirMatch(eventsAirLookup);
  const primaryMembershipType = selectedEventsAirMatch ? selectedEventsAirMatch.primary_membership_type : null;
  const addonMembershipTypes = selectedEventsAirMatch ? selectedEventsAirMatch.addon_membership_types || [] : [];
  const subscriptionItemPreview = buildSubscriptionItemsFromRegistrationTypes({
    primaryMembershipType,
    addonMembershipTypes,
  });

  const hasExisting = existingSubscriptions.data.some((sub) =>
    ['active', 'trialing', 'past_due'].includes(sub.status),
  );

  const hasOpenInvoiceNeedingPayment = openInvoices.data.some(
    (invoice) => (invoice.amount_remaining || 0) > 0,
  );

  const latestCharge = charges.data[0] || null;
  const referenceTimestamp = latestCharge ? latestCharge.created : Math.floor(Date.now() / 1000);
  const referenceAmount = latestCharge ? latestCharge.amount : null;

  // Previous logic kept each subscription on a rolling 365-day cycle.
  // Renewals are now aligned to 7 January of the following calendar year at
  // 12:00 noon Belgium time for the EventsAir migration.
  const plannedTrialEndUnix = getNextRenewalJanuarySeventhUnix(referenceTimestamp);

  const cleanupPreview = {
    pending_invoice_item_ids_to_delete: pendingInvoiceItems.data
      .filter((item) => isLikelyCheckoutArtifact(item, referenceTimestamp, referenceAmount))
      .map((item) => item.id),
    draft_invoice_ids_to_delete: draftInvoices.data
      .filter((invoice) => {
        const withinWindow = Math.abs(invoice.created - referenceTimestamp) <= checkoutArtifactWindowSeconds;
        const zeroBalanceDraft = (invoice.amount_due || 0) === 0;
        return withinWindow && zeroBalanceDraft && invoice.customer === customer.id;
      })
      .map((invoice) => invoice.id),
  };

  const stripeMetadata = buildStripeMetadata({
    primaryMembershipType,
    addonMembershipTypes,
  });

  const preparedSubscriptionPayload = selectedEventsAirMatch
    && subscriptionItemPreview.items.length > 0
    && subscriptionItemPreview.missing_price_mappings.length === 0
    && paymentMethods.data[0]
    && defaultTaxRateId
    ? {
        customer: customer.id,
        items: subscriptionItemPreview.items.map((item) => ({ price: item.price })),
        default_payment_method: paymentMethods.data[0].id,
        collection_method: 'charge_automatically',
        default_tax_rates: [defaultTaxRateId],
        payment_behavior: 'error_if_incomplete',
        trial_end: plannedTrialEndUnix,
        proration_behavior: 'none',
        metadata: stripeMetadata,
      }
    : null;

  const preparedCustomerMetadata = selectedEventsAirMatch
    ? {
        source: 'eventsair',
      }
    : null;

  const preparedSubscriptionMetadata = selectedEventsAirMatch
    ? {
        source: 'eventsair',
        primary_membership_type: primaryMembershipType || '',
        addon_membership_types: addonMembershipTypes,
      }
    : null;

  let wouldSkipReason = null;
  if (!paymentMethods.data[0]) {
    wouldSkipReason = 'no-payment-method';
  } else if (!selectedEventsAirMatch) {
    wouldSkipReason = 'no-eventsair-match';
  } else if (!primaryMembershipType) {
    wouldSkipReason = 'missing-primary-membership-type';
  } else if (subscriptionItemPreview.missing_price_mappings.length > 0) {
    wouldSkipReason = 'missing-price-mapping';
  } else if (hasExisting) {
    wouldSkipReason = 'existing-subscription';
  } else if (hasOpenInvoiceNeedingPayment) {
    wouldSkipReason = 'open-invoice-needing-payment';
  } else if (!defaultTaxRateId) {
    wouldSkipReason = 'missing-tax-rate';
  }

  const canCreateSubscription = !wouldSkipReason;

  let createdSubscription = null;
  let createAttempt = null;
  let cleanupResult = null;
  if (createSubscriptions && canCreateSubscription && preparedSubscriptionPayload) {
    await stripe.customers.update(customer.id, {
      invoice_settings: {
        default_payment_method: paymentMethods.data[0].id,
      },
      metadata: {
        ...(customer.metadata || {}),
        source: 'eventsair',
      },
    });

    cleanupResult = await cleanupCheckoutBillingArtifacts({
      customerId: customer.id,
      pendingInvoiceItems: pendingInvoiceItems.data,
      draftInvoices: draftInvoices.data,
      referenceTimestamp,
      referenceAmount,
    });

    const subscription = await stripe.subscriptions.create(preparedSubscriptionPayload);
    createdSubscription = summarizeSubscription(subscription);
    createAttempt = {
      attempted: true,
      created: true,
      create_subscriptions_enabled: true,
      cleanup_performed: true,
    };
  } else {
    createAttempt = {
      attempted: createSubscriptions,
      created: false,
      create_subscriptions_enabled: createSubscriptions,
      reason: canCreateSubscription ? 'preview-only' : wouldSkipReason,
      cleanup_performed: false,
    };
  }

  const result = {
    customer: {
      id: customer.id,
      email: customer.email,
      name: customer.name,
    },
    customer_metadata_preview: preparedCustomerMetadata,
    subscription_metadata_preview: preparedSubscriptionMetadata,
    eventsair_lookup: {
      email,
      found: Boolean(selectedEventsAirMatch),
      event_id: selectedEventsAirMatch && selectedEventsAirMatch.event_id ? selectedEventsAirMatch.event_id : null,
      event_name: selectedEventsAirMatch && selectedEventsAirMatch.event_name ? selectedEventsAirMatch.event_name : null,
      total_matches: eventsAirLookup && typeof eventsAirLookup.total_matches === 'number'
        ? eventsAirLookup.total_matches
        : 0,
      total_events_scanned: eventsAirLookup && typeof eventsAirLookup.total_events_scanned === 'number'
        ? eventsAirLookup.total_events_scanned
        : null,
      selected_match: summarizeEventsAirMatch(selectedEventsAirMatch),
      scanned_events: eventsAirLookup && Array.isArray(eventsAirLookup.scanned_events)
        ? eventsAirLookup.scanned_events.filter((event) => event.match_count > 0)
        : [],
      errors: eventsAirLookup && eventsAirLookup.errors ? eventsAirLookup.errors : null,
      error: eventsAirLookup && eventsAirLookup.error ? eventsAirLookup.error : null,
    },
    latest_charge: latestCharge
      ? {
          amount: latestCharge.amount,
          currency: latestCharge.currency,
          created_iso: toIso(latestCharge.created),
          description: latestCharge.description,
        }
      : null,
    decision: {
      can_create_subscription: canCreateSubscription,
      create_subscriptions_enabled: createSubscriptions,
      would_skip_reason: wouldSkipReason,
      has_saved_card: Boolean(paymentMethods.data[0]),
      has_existing_subscription: hasExisting,
      has_open_invoice_needing_payment: hasOpenInvoiceNeedingPayment,
      mapped_subscription_items: subscriptionItemPreview.items,
      missing_price_mappings: subscriptionItemPreview.missing_price_mappings,
      default_tax_rate_id: defaultTaxRateId,
      planned_trial_end_iso: toIso(plannedTrialEndUnix),
    },
    existing_subscriptions: existingSubscriptions.data.map(summarizeSubscription),
    open_invoices: openInvoices.data.map(summarizeInvoice),
    cleanup_preview: cleanupPreview,
    pending_invoice_items_to_review: pendingInvoiceItems.data
      .filter((item) => cleanupPreview.pending_invoice_item_ids_to_delete.includes(item.id))
      .map(summarizeInvoiceItem),
    draft_invoices_to_review: draftInvoices.data
      .filter((invoice) => cleanupPreview.draft_invoice_ids_to_delete.includes(invoice.id))
      .map(summarizeInvoice),
    cleanup_result: cleanupResult,
    create_attempt: createAttempt,
    created_subscription: createdSubscription,
    prepared_subscription_payload: preparedSubscriptionPayload,
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
