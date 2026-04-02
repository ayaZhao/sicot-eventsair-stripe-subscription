import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import { lookupMembershipContactsByEmail } from './eventsair-api.js';
import { buildSubscriptionItemsFromRegistrationTypes } from './registration-type-map.js';

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const port = Number(process.env.PORT || 3000);
const createSubscriptions = process.env.CREATE_SUBSCRIPTIONS === 'true';
const defaultTaxRateId = process.env.STRIPE_DEFAULT_TAX_RATE_ID || null;
const checkoutArtifactWindowSeconds = 30 * 60;
const freeMembershipCaptureAmountCents = 50;
const freeMembershipCaptureCurrency = 'eur';

function toIso(unixSeconds) {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
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
    collection_method: invoice.collection_method,
    total: invoice.total,
    amount_due: invoice.amount_due,
    amount_remaining: invoice.amount_remaining,
    created: invoice.created,
    created_iso: toIso(invoice.created),
  };
}

function summarizeInvoiceItem(invoiceItem) {
  return {
    id: invoiceItem.id,
    amount: invoiceItem.amount,
    currency: invoiceItem.currency,
    description: invoiceItem.description,
    invoice: invoiceItem.invoice,
    date: invoiceItem.date,
    date_iso: toIso(invoiceItem.date),
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

function isFreeUserRefundCandidate({ primaryMembershipType, addonMembershipTypes, session }) {
  // A free membership checkout is modeled as a temporary 0.50 EUR card-capture payment
  // with a primary membership type and no addon registrations.
  const hasPrimaryMembership = Boolean(primaryMembershipType);
  const hasNoAddons = Array.isArray(addonMembershipTypes) && addonMembershipTypes.length === 0;
  const isOneCentCheckout = session
    && session.amount_total === freeMembershipCaptureAmountCents
    && String(session.currency || '').toLowerCase() === freeMembershipCaptureCurrency;

  return hasPrimaryMembership && hasNoAddons && isOneCentCheckout;
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

app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (error) {
    console.error('Webhook signature verification failed:', error.message);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const customerId = session.customer;
      if (!customerId) {
        console.log('No customer found on checkout session');
        return res.json({ received: true, skipped: 'no-customer' });
      }

      const customer = await stripe.customers.retrieve(customerId);
      const email = customer.email;
      const eventsAirLookup = await lookupMembershipContactsByEmail(email);
      const selectedEventsAirMatch = selectBestEventsAirMatch(eventsAirLookup);
      const primaryMembershipType = selectedEventsAirMatch ? selectedEventsAirMatch.primary_membership_type : null;
      const addonMembershipTypes = selectedEventsAirMatch ? selectedEventsAirMatch.addon_membership_types || [] : [];
      const subscriptionItemPreview = buildSubscriptionItemsFromRegistrationTypes({
        primaryMembershipType,
        addonMembershipTypes,
      });

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

      const trialEnd = session.created + 365 * 24 * 60 * 60;
      const defaultPaymentMethod = paymentMethods.data[0] || null;
      const isFreeUserFlow = isFreeUserRefundCandidate({
        primaryMembershipType,
        addonMembershipTypes,
        session,
      });
      const stripeMetadata = buildStripeMetadata({
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
        checkout_created_unix: session.created,
        checkout_created_iso: toIso(session.created),
        customer: {
          id: customerId,
          email,
          name: customer.name,
          metadata: customer.metadata,
        },
        checkout_payment: {
          amount_total: session.amount_total,
          currency: session.currency || null,
          payment_intent: session.payment_intent || null,
        },
        eventsair_lookup: {
          email,
          found: Boolean(selectedEventsAirMatch),
          event_id: eventsAirLookup && eventsAirLookup.event_id ? eventsAirLookup.event_id : null,
          event_name: eventsAirLookup && eventsAirLookup.event_name ? eventsAirLookup.event_name : null,
          total_matches: eventsAirLookup && typeof eventsAirLookup.total_matches === 'number'
            ? eventsAirLookup.total_matches
            : 0,
          selected_match: summarizeEventsAirMatch(selectedEventsAirMatch),
          errors: eventsAirLookup && eventsAirLookup.errors ? eventsAirLookup.errors : null,
        },
        customer_metadata_preview: {
          source: 'eventsair',
        },
        subscription_metadata_preview: {
          source: 'eventsair',
          primary_membership_type: primaryMembershipType || '',
          addon_membership_types: addonMembershipTypes,
        },
        default_payment_method: summarizePaymentMethod(defaultPaymentMethod),
        has_existing_subscription: hasExisting,
        existing_subscriptions_count: existingSubscriptions.data.length,
        existing_subscriptions: existingSubscriptions.data.map(summarizeSubscription),
        pending_invoice_items_count: pendingInvoiceItems.data.length,
        pending_invoice_items: pendingInvoiceItems.data.map(summarizeInvoiceItem),
        draft_invoices_count: draftInvoices.data.length,
        draft_invoices: draftInvoices.data.map(summarizeInvoice),
        open_invoices_count: openInvoices.data.length,
        open_invoices: openInvoices.data.map(summarizeInvoice),
        planned_trial_end_unix: trialEnd,
        planned_trial_end_iso: toIso(trialEnd),
        flow_type: isFreeUserFlow ? 'free-user-refund' : 'paid-membership',
        free_user_evaluation: {
          eligible_for_auto_refund: isFreeUserFlow,
          requires_primary_membership_type: Boolean(primaryMembershipType),
          requires_no_addons: addonMembershipTypes.length === 0,
          requires_point_five_euro_checkout: session.amount_total === freeMembershipCaptureAmountCents
            && String(session.currency || '').toLowerCase() === freeMembershipCaptureCurrency,
        },
        mapped_subscription_items: subscriptionItemPreview.items,
        missing_price_mappings: subscriptionItemPreview.missing_price_mappings,
        default_tax_rate_id: defaultTaxRateId,
        create_subscriptions_enabled: createSubscriptions,
        subscription_create_params: subscriptionCreateParams,
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
        console.log(JSON.stringify(debugResult, null, 2));
        return res.json({ received: true, skipped: 'no-eventsair-match' });
      }

      if (!primaryMembershipType) {
        debugResult.note = 'No primary membership type found in EventsAIR registrations. Subscription was not created.';
        console.log(JSON.stringify(debugResult, null, 2));
        return res.json({ received: true, skipped: 'missing-primary-membership-type' });
      }

      if (isFreeUserFlow) {
        // Refund the temporary card-capture charge before continuing with
        // subscription creation so free users are never left with a retained 0.50 EUR payment.
        await refundFreeUserCapture();
      }

      if (subscriptionItemPreview.missing_price_mappings.length > 0) {
        debugResult.note = 'One or more registration types do not have Stripe price mappings. Subscription was not created.';
        console.log(JSON.stringify(debugResult, null, 2));
        return res.json({ received: true, skipped: 'missing-price-mapping' });
      }

      if (!defaultPaymentMethod || !defaultPaymentMethod.id) {
        debugResult.note = 'No saved payment method found. Subscription was not created.';
        console.log(JSON.stringify(debugResult, null, 2));
        return res.json({ received: true, skipped: 'no-payment-method' });
      }

      if (hasExisting) {
        debugResult.note = 'Existing subscription found. No new subscription was created.';
        console.log(JSON.stringify(debugResult, null, 2));
        return res.json({ received: true, skipped: 'existing-subscription' });
      }

      if (hasOpenInvoiceNeedingPayment) {
        debugResult.note = 'Open invoice requiring payment found. Subscription was not created to avoid an unexpected second charge.';
        console.log(JSON.stringify(debugResult, null, 2));
        return res.json({ received: true, skipped: 'open-invoice-needing-payment' });
      }

      if (!defaultTaxRateId) {
        debugResult.note = 'STRIPE_DEFAULT_TAX_RATE_ID is not configured. Subscription was not created because 21% VAT is required.';
        console.log(JSON.stringify(debugResult, null, 2));
        return res.json({ received: true, skipped: 'missing-tax-rate' });
      }

      if (!createSubscriptions) {
        debugResult.note = 'Preview mode only. No subscription created. Set CREATE_SUBSCRIPTIONS=true to enable creation.';
        console.log(JSON.stringify(debugResult, null, 2));
        return res.json({ received: true, preview: true });
      }

      await stripe.customers.update(customerId, {
        invoice_settings: {
          default_payment_method: defaultPaymentMethod.id,
        },
        metadata: {
          ...customer.metadata,
          source: 'eventsair',
        },
      });

      const cleanupResult = await cleanupCheckoutBillingArtifacts({
        customerId,
        session,
        pendingInvoiceItems: pendingInvoiceItems.data,
        draftInvoices: draftInvoices.data,
      });

      debugResult.cleanup_result = cleanupResult;

      // Both paid users and free users receive the same future renewal subscription.
      // Paid users keep the checkout payment, while free users have already had their
      // temporary 0.50 EUR card-capture charge refunded before subscription creation.
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
      console.log(JSON.stringify(debugResult, null, 2));
    }

    return res.json({ received: true });
  } catch (error) {
    console.error('Webhook handling failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`Webhook server listening on http://localhost:${port}`);
  console.log(`CREATE_SUBSCRIPTIONS=${createSubscriptions}`);
});
