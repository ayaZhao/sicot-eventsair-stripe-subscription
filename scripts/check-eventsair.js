import 'dotenv/config';
import { lookupMembershipContactsByEmail } from '../src/eventsair-api.js';

const email = process.argv[2];

if (!email) {
  console.error('Usage: npm run check:eventsair -- user@example.com');
  process.exit(1);
}

async function main() {
  const result = await lookupMembershipContactsByEmail(email);

  const summarizedMatches = (result.matches || []).map((match) => ({
    source_kind: match.source_kind,
    event_id: match.event_id,
    event_name: match.event_name,
    contact_id: match.contact.id,
    internal_number: match.contact.internalNumber,
    first_name: match.contact.firstName,
    last_name: match.contact.lastName,
    primary_email: match.contact.primaryEmail,
    external_identifier: match.contact.externalIdentifier,
    registration_type_names: (match.contact.registrations || [])
      .map((registration) => (registration.type ? registration.type.name : null))
      .filter(Boolean),
    primary_membership_type: match.primary_membership_type || null,
    primary_registration: match.primary_registration
      ? {
          id: match.primary_registration.id,
          type_id: match.primary_registration.type ? match.primary_registration.type.id : null,
          type_name: match.primary_registration.type ? match.primary_registration.type.name : null,
        }
      : null,
    addon_membership_types: match.addon_membership_types || [],
    addon_registrations: (match.addon_registrations || []).map((registration) => ({
      id: registration.id,
      type_id: registration.type ? registration.type.id : null,
      type_name: registration.type ? registration.type.name : null,
    })),
    registrations: (match.contact.registrations || []).map((registration) => ({
      id: registration.id,
      type_id: registration.type ? registration.type.id : null,
      type_name: registration.type ? registration.type.name : null,
    })),
    function_registrations: (match.contact.functionRegistrations || []).map((registration) => ({
      id: registration.id,
      fee_type_id: registration.feeType ? registration.feeType.id : null,
      fee_type_name: registration.feeType ? registration.feeType.name : null,
    })),
  }));

  console.log(JSON.stringify({
    email: result.email,
    found: result.found,
    event_id: result.event_id || null,
    event_name: result.event_name || null,
    total_stores_scanned: result.total_stores_scanned,
    total_matches: result.total_matches,
    recommended_env: {
      EVENTSAIR_CONTACT_LOOKUP_MEMBER_ID_PATH: result.recommended_member_id_path,
      EVENTSAIR_CONTACT_LOOKUP_MEMBERSHIP_TYPE_PATH: result.recommended_membership_type_path,
    },
    matches: summarizedMatches,
    errors: result.errors || null,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});