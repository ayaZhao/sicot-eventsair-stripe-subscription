# Stripe EventsAir Membership Webhook

This project handles the Stripe webhook flow for the EventsAir-based SICOT membership renewal process.

It is a small Node.js service that:

- verifies Stripe webhook signatures
- looks up the member in EventsAir by email
- reads the member's registration types from EventsAir
- maps EventsAir registration types to Stripe recurring prices
- optionally refunds the temporary free-member card capture
- creates the yearly Stripe subscription with VAT applied
- writes structured webhook logs and event-dedupe state to local files

## Runtime

- Node.js: `>= 18`
- Recommended local/runtime version: `Node 20`
- Package manager: `npm`
- Module format: `ESM`

## Local Setup

Install dependencies:

```bash
npm install
```

Start the webhook server:

```bash
npm run webhook
```

The local server will listen on:

```text
http://localhost:3000
```

Health check:

```text
GET /health
```

Webhook endpoint:

```text
POST /api/eventsair/v1/stripe/webhook
```

## Main Business Rules

The webhook implements the current subscription rules described for the EventsAir membership flow:

1. Membership type resolution comes from the attendee's `registrations` in EventsAir.
2. The webhook queries EventsAir by email after Stripe checkout completes.
3. The returned registration types are classified into:
   - one primary membership type
   - zero or more addon membership types
4. Stripe subscription items are created from the mapped registration types.
5. A free member is currently modeled as:
   - a valid primary membership type
   - no addon registrations
   - a temporary Stripe checkout charge of `0.50 EUR`
6. If the checkout matches that free-member rule, the webhook refunds the temporary `0.50 EUR` charge before creating the yearly subscription.
7. Paid members are not refunded.
8. All created subscriptions use the configured Stripe tax rate, which is expected to represent the required VAT.

## Request Flow

The main webhook route is:

`POST /api/eventsair/v1/stripe/webhook`


## Local Stripe Testing

Expose the local server with a tunnel such as ngrok, then configure Stripe test mode to send events to:

```text
https://your-ngrok-domain/api/eventsair/v1/stripe/webhook
```

Use the endpoint-specific `whsec_...` secret from Stripe test mode in:

```text
STRIPE_WEBHOOK_SECRET
```

## Deployment Notes

For live mode, deploy this service to a stable public HTTPS URL such as:

```text
https://your-domain/api/eventsair/v1/stripe/webhook
```

Recommended live deployment approach:

1. Deploy the new EventsAir webhook as a separate endpoint.
2. Keep the old system webhook in place.
3. Configure a new live Stripe webhook destination for this service.
4. Use the new live destination's own `whsec_...` secret.
5. Test the new endpoint with a small live rollout before broader use.

## Logging

The webhook writes structured event logs:

- to stdout
- and to a JSON-lines file

Default log file:

```text
logs/webhook.log
```

Default Stripe event dedupe state file:

```text
.runtime/processed-stripe-events.json
```

These files help validate behavior in test mode before deploying the same code to live mode.
