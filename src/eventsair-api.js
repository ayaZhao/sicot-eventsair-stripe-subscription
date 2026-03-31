import 'dotenv/config';
import fetch from 'node-fetch';

const defaultGraphqlUrl = 'https://api.eventsair.com/graphql';
const defaultTokenScope = 'https://eventsairprod.onmicrosoft.com/85d8f626-4e3d-4357-89c6-327d4e6d3d93/.default';
const eventRegistrationTypesQuery = `
  query ListEventRegistrationTypes($eventId: ID!) {
    event(id: $eventId) {
      id
      name
      setup {
        registration {
          registrationTypes(offset: 0, limit: 200) {
            id
            name
            uniqueCode
            fees {
              amount
              currency {
                code
              }
            }
          }
        }
      }
    }
  }
`;
const eventContactLookupQuery = `
  query LookupEventContactsByEmail($eventId: ID!, $email: String!) {
    event(id: $eventId) {
      id
      name
      contacts(input: { contactFilter: { primaryEmail: $email, includeInactive: true } }, offset: 0, limit: 20) {
        id
        internalNumber
        firstName
        lastName
        primaryEmail
        externalIdentifier
        registrations {
          id
          type {
            id
            name
          }
        }
        functionRegistrations {
          id
          feeType {
            id
            name
          }
        }
      }
    }
  }
`;
const eventsListQuery = `
  query ListEvents($offset: NonNegativeInt!, $limit: PaginationLimit!) {
    events(input: {}, offset: $offset, limit: $limit) {
      id
      name
    }
  }
`;

function normalizeTypeName(typeName) {
  return typeof typeName === 'string' ? typeName.trim().toLowerCase() : null;
}

function getPrimaryMembershipTypeNames() {
  const configuredNames = process.env.EVENTSAIR_PRIMARY_MEMBERSHIP_TYPES;
  if (!configuredNames) {
    return ['active member', 'associate membership'];
  }

  return configuredNames
    .split(',')
    .map((value) => normalizeTypeName(value))
    .filter(Boolean);
}

function isPrimaryMembershipTypeName(typeName) {
  const normalizedTypeName = normalizeTypeName(typeName);
  if (!normalizedTypeName) {
    return false;
  }

  return getPrimaryMembershipTypeNames().includes(normalizedTypeName);
}

export function classifyRegistrations(registrations) {
  const normalizedRegistrations = Array.isArray(registrations) ? registrations : [];
  const primaryRegistrationIndex = normalizedRegistrations.findIndex((registration) => {
    return isPrimaryMembershipTypeName(registration && registration.type ? registration.type.name : null);
  });

  const primaryRegistration = primaryRegistrationIndex >= 0
    ? normalizedRegistrations[primaryRegistrationIndex]
    : null;

  const addonRegistrations = normalizedRegistrations.filter((registration, index) => {
    return index !== primaryRegistrationIndex;
  });

  return {
    primary_registration: primaryRegistration,
    primary_membership_type: primaryRegistration && primaryRegistration.type
      ? primaryRegistration.type.name
      : null,
    addon_registrations: addonRegistrations,
    addon_membership_types: addonRegistrations
      .map((registration) => (registration && registration.type ? registration.type.name : null))
      .filter(Boolean),
  };
}

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not configured`);
  }

  return value;
}

function getByPath(object, pathExpression) {
  if (!object || !pathExpression) {
    return null;
  }

  return pathExpression.split('.').reduce((current, part) => {
    if (current == null) {
      return null;
    }

    if (/^\d+$/.test(part)) {
      return current[Number(part)] == null ? null : current[Number(part)];
    }

    return current[part] == null ? null : current[part];
  }, object);
}

export async function getEventsAirAccessToken() {
  const tenantId = getRequiredEnv('EVENTSAIR_TENANT_ID');
  const clientId = getRequiredEnv('EVENTSAIR_CLIENT_ID');
  const clientSecret = getRequiredEnv('EVENTSAIR_CLIENT_SECRET');
  const tokenScope = process.env.EVENTSAIR_TOKEN_SCOPE || defaultTokenScope;

  const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: tokenScope,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`EventsAIR access token request failed: ${response.status} ${response.statusText} ${errorText}`);
  }

  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error('EventsAIR access token response did not include access_token');
  }

  return payload.access_token;
}

export async function runEventsAirGraphqlQuery({ query, variables }) {
  const accessToken = await getEventsAirAccessToken();
  const graphqlUrl = process.env.EVENTSAIR_GRAPHQL_URL || defaultGraphqlUrl;

  const response = await fetch(graphqlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`EventsAIR GraphQL request failed: ${response.status} ${response.statusText} ${errorText}`);
  }

  return response.json();
}

export async function fetchEventsAirMetadataByEmail(email) {
  if (!email) {
    throw new Error('Email is required for EventsAIR lookup');
  }

  const query = process.env.EVENTSAIR_CONTACT_LOOKUP_QUERY;
  if (!query) {
    return {
      enabled: false,
      reason: 'EVENTSAIR_CONTACT_LOOKUP_QUERY is not configured',
    };
  }

  const responsePath = process.env.EVENTSAIR_CONTACT_LOOKUP_RESPONSE_PATH;
  const memberIdPath = process.env.EVENTSAIR_CONTACT_LOOKUP_MEMBER_ID_PATH || 'id';
  const membershipTypePath = process.env.EVENTSAIR_CONTACT_LOOKUP_MEMBERSHIP_TYPE_PATH || 'registrationType.name';

  const payload = await runEventsAirGraphqlQuery({
    query,
    variables: { email },
  });

  if (payload.errors && payload.errors.length > 0) {
    return {
      enabled: true,
      found: false,
      errors: payload.errors,
      raw_payload: payload,
    };
  }

  const record = responsePath ? getByPath(payload, responsePath) : payload.data;
  const normalizedRecord = Array.isArray(record) ? record[0] || null : record;

  return {
    enabled: true,
    found: Boolean(normalizedRecord),
    response_path: responsePath || null,
    member_id: getByPath(normalizedRecord, memberIdPath),
    membership_type: getByPath(normalizedRecord, membershipTypePath),
    record: normalizedRecord,
    raw_payload: payload,
  };
}

export async function lookupMembershipContactsByEmail(email) {
  if (!email) {
    throw new Error('Email is required for EventsAIR membership contact lookup');
  }

  const eventId = getRequiredEnv('EVENTSAIR_CONTACT_LOOKUP_EVENT_ID');
  const eventPayload = await runEventsAirGraphqlQuery({
    query: eventContactLookupQuery,
    variables: {
      eventId,
      email,
    },
  });

  if (eventPayload.errors && eventPayload.errors.length > 0) {
    return {
      email,
      found: false,
      errors: eventPayload.errors,
      raw_payload: eventPayload,
    };
  }

  const eventRecord = eventPayload.data && eventPayload.data.event
    ? eventPayload.data.event
    : null;
  const contacts = eventRecord && eventRecord.contacts ? eventRecord.contacts : [];
  const matches = [];

  contacts.forEach((contact) => {
    const registrationClassification = classifyRegistrations(contact.registrations);

    matches.push({
      source_kind: 'event_contact',
      event_id: eventRecord ? eventRecord.id : eventId,
      event_name: eventRecord ? eventRecord.name : null,
      contact,
      primary_registration: registrationClassification.primary_registration,
      primary_membership_type: registrationClassification.primary_membership_type,
      addon_registrations: registrationClassification.addon_registrations,
      addon_membership_types: registrationClassification.addon_membership_types,
    });
  });

  return {
    email,
    found: matches.length > 0,
    event_id: eventRecord ? eventRecord.id : eventId,
    event_name: eventRecord ? eventRecord.name : null,
    total_stores_scanned: eventRecord ? 1 : 0,
    total_matches: matches.length,
    recommended_member_id_path: 'contact.internalNumber',
    recommended_membership_type_path: matches.length > 0 ? 'primary_registration.type.name' : null,
    matches,
    raw_payload: eventPayload,
  };
}

async function listEventsAirEvents({ pageSize = 50 } = {}) {
  const events = [];
  let offset = 0;

  while (true) {
    const payload = await runEventsAirGraphqlQuery({
      query: eventsListQuery,
      variables: {
        offset,
        limit: pageSize,
      },
    });

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`EventsAIR event list query failed: ${JSON.stringify(payload.errors)}`);
    }

    const page = payload && payload.data && Array.isArray(payload.data.events)
      ? payload.data.events
      : [];

    events.push(...page);

    if (page.length < pageSize) {
      break;
    }

    offset += page.length;
  }

  return events;
}

function normalizeEventPriority(event, configuredEventId) {
  if (configuredEventId && event.id === configuredEventId) {
    return 0;
  }

  return 1;
}

function buildEventLookupResult({ email, eventPayload, fallbackEventId = null }) {
  if (eventPayload.errors && eventPayload.errors.length > 0) {
    return {
      email,
      found: false,
      errors: eventPayload.errors,
      raw_payload: eventPayload,
      matches: [],
    };
  }

  const eventRecord = eventPayload.data && eventPayload.data.event
    ? eventPayload.data.event
    : null;
  const contacts = eventRecord && Array.isArray(eventRecord.contacts)
    ? eventRecord.contacts
    : [];
  const matches = [];

  contacts.forEach((contact) => {
    const registrationClassification = classifyRegistrations(contact.registrations);

    matches.push({
      source_kind: 'event_contact',
      event_id: eventRecord ? eventRecord.id : fallbackEventId,
      event_name: eventRecord ? eventRecord.name : null,
      contact,
      primary_registration: registrationClassification.primary_registration,
      primary_membership_type: registrationClassification.primary_membership_type,
      addon_registrations: registrationClassification.addon_registrations,
      addon_membership_types: registrationClassification.addon_membership_types,
    });
  });

  return {
    email,
    found: matches.length > 0,
    event_id: eventRecord ? eventRecord.id : fallbackEventId,
    event_name: eventRecord ? eventRecord.name : null,
    total_stores_scanned: eventRecord ? 1 : 0,
    total_matches: matches.length,
    recommended_member_id_path: 'contact.internalNumber',
    recommended_membership_type_path: matches.length > 0 ? 'primary_registration.type.name' : null,
    matches,
    raw_payload: eventPayload,
  };
}

export async function lookupMembershipContactsByEmailAcrossEvents(email) {
  if (!email) {
    throw new Error('Email is required for EventsAIR cross-event membership contact lookup');
  }

  const configuredEventId = process.env.EVENTSAIR_CONTACT_LOOKUP_EVENT_ID || null;
  const events = await listEventsAirEvents();
  const orderedEvents = [...events].sort((left, right) => {
    return normalizeEventPriority(left, configuredEventId) - normalizeEventPriority(right, configuredEventId);
  });

  const matches = [];
  const scannedEvents = [];
  const errors = [];

  for (const event of orderedEvents) {
    const eventPayload = await runEventsAirGraphqlQuery({
      query: eventContactLookupQuery,
      variables: {
        eventId: event.id,
        email,
      },
    });

    const eventResult = buildEventLookupResult({
      email,
      eventPayload,
      fallbackEventId: event.id,
    });

    scannedEvents.push({
      event_id: event.id,
      event_name: event.name,
      match_count: eventResult.matches.length,
    });

    if (eventResult.errors && eventResult.errors.length > 0) {
      errors.push({
        event_id: event.id,
        event_name: event.name,
        errors: eventResult.errors,
      });
      continue;
    }

    matches.push(...eventResult.matches);
  }

  return {
    email,
    found: matches.length > 0,
    total_events_scanned: scannedEvents.length,
    total_matches: matches.length,
    recommended_member_id_path: 'contact.internalNumber',
    recommended_membership_type_path: matches.length > 0 ? 'primary_registration.type.name' : null,
    matches,
    scanned_events: scannedEvents,
    errors,
  };
}

export async function fetchEventRegistrationTypes(eventId = null) {
  const resolvedEventId = eventId || getRequiredEnv('EVENTSAIR_CONTACT_LOOKUP_EVENT_ID');
  const eventPayload = await runEventsAirGraphqlQuery({
    query: eventRegistrationTypesQuery,
    variables: {
      eventId: resolvedEventId,
    },
  });

  if (eventPayload.errors && eventPayload.errors.length > 0) {
    return {
      found: false,
      event_id: resolvedEventId,
      errors: eventPayload.errors,
      raw_payload: eventPayload,
      registration_types: [],
    };
  }

  const eventRecord = eventPayload.data && eventPayload.data.event
    ? eventPayload.data.event
    : null;
  const registrationTypes = eventRecord
    && eventRecord.setup
    && eventRecord.setup.registration
    && Array.isArray(eventRecord.setup.registration.registrationTypes)
    ? eventRecord.setup.registration.registrationTypes
    : [];

  return {
    found: Boolean(eventRecord),
    event_id: eventRecord ? eventRecord.id : resolvedEventId,
    event_name: eventRecord ? eventRecord.name : null,
    total_registration_types: registrationTypes.length,
    registration_types: registrationTypes.map((registrationType) => ({
      id: registrationType.id,
      name: registrationType.name,
      unique_code: registrationType.uniqueCode || null,
      fees: Array.isArray(registrationType.fees)
        ? registrationType.fees.map((fee) => ({
            amount: fee.amount,
            currency_code: fee.currency ? fee.currency.code : null,
          }))
        : [],
    })),
    raw_payload: eventPayload,
  };
}
