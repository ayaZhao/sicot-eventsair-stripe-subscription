import 'dotenv/config';

function normalizeMembershipType(value) {
  if (!value) return null;
  const lower = String(value).toLowerCase();
  if (lower.includes('active')) return 'active';
  if (lower.includes('associate')) return 'associate';
  return lower;
}

export async function lookupMemberByEmail(email) {
  if (!email) {
    throw new Error('Email is required for member lookup');
  }

  if (process.env.USE_LOCAL_MEMBER_MAP === 'true') {
    const localEmail = process.env.LOCAL_MEMBER_EMAIL;
    if (email.toLowerCase() !== String(localEmail || '').toLowerCase()) {
      return null;
    }

    return {
      member_id: process.env.LOCAL_MEMBER_ID,
      membership_type: normalizeMembershipType(process.env.LOCAL_MEMBERSHIP_TYPE),
      source: 'local-map',
    };
  }

  const lookupUrl = process.env.EVENTSAIR_MEMBER_LOOKUP_URL;
  if (!lookupUrl) {
    throw new Error('EVENTSAIR_MEMBER_LOOKUP_URL is not configured');
  }

  const response = await fetch(`${lookupUrl}?email=${encodeURIComponent(email)}`, {
    headers: {
      Authorization: `Bearer ${process.env.EVENTSAIR_API_TOKEN || ''}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Member lookup failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (!payload) return null;

  return {
    member_id: payload.member_id,
    membership_type: normalizeMembershipType(payload.membership_type),
    source: 'eventsair-api',
  };
}
