import 'dotenv/config';
import { fetchEventRegistrationTypes } from '../src/eventsair-api.js';
import { buildRegistrationTypeStripeTemplate } from '../src/registration-type-map.js';

const eventId = process.argv[2] || process.env.EVENTSAIR_CONTACT_LOOKUP_EVENT_ID;

if (!eventId) {
  console.error('Usage: npm run list:registration-types -- <eventsair-event-id>');
  process.exit(1);
}

async function main() {
  const result = await fetchEventRegistrationTypes(eventId);
  const firstError = Array.isArray(result.errors) ? result.errors[0] : null;
  const isForbidden = firstError
    && firstError.extensions
    && Number(firstError.extensions.status) === 403;

  console.log(JSON.stringify({
    event_id: result.event_id,
    event_name: result.event_name,
    total_registration_types: result.total_registration_types,
    registration_types: result.registration_types,
    stripe_mapping_template: buildRegistrationTypeStripeTemplate(result.registration_types),
    note: isForbidden
      ? 'Current EventsAir API permissions do not allow reading event.setup.registration.registrationTypes. Ask EventsAir to grant access to registration setup data, or use the UI export/list instead.'
      : null,
    errors: result.errors || null,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
