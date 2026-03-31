import 'dotenv/config';

function normalizeTypeName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export const stripeCatalogConfig = {
  mode: 'test',
  primaryMembershipTypes: [
    'Active Member',
    'Associate Member',
  ],

  aliases: {
    'Associate Membership': 'Associate Member',
  },

  priceMap: {
    'Active Member': {
      role: 'primary',
      priceId: 'price_1TF8EzCsrIQtLPXlG3RH6E8k',
    },
    'Associate Member': {
      role: 'primary',
      priceId: 'price_1TF8FgCsrIQtLPXlddQ94zg0',
    },
    Test: {
      role: 'addon',
      priceId: 'price_1TGv6jCsrIQtLPXldSwPU1id',
    },
    'National Fund - France': {
      role: 'addon',
      priceId: 'price_1TGv9UCsrIQtLPXlYy03I0rQ',
    },
    'SICOT CONECT - Digital Orthopaedics & AI': {
      role: 'addon',
      priceId: 'price_1TGvAFCsrIQtLPXl6xGVjMA3',
    },
  },
};

export function resolveRegistrationTypeAlias(regTypeName) {
  if (!regTypeName) {
    return null;
  }

  const directAlias = stripeCatalogConfig.aliases[regTypeName];
  if (directAlias) {
    return directAlias;
  }

  const normalizedInput = normalizeTypeName(regTypeName);
  const matchedAliasEntry = Object.entries(stripeCatalogConfig.aliases).find(([sourceName]) => {
    return normalizeTypeName(sourceName) === normalizedInput;
  });

  return matchedAliasEntry ? matchedAliasEntry[1] : regTypeName;
}

export function isPrimaryMembershipType(regTypeName) {
  const resolvedName = resolveRegistrationTypeAlias(regTypeName);
  const normalizedResolvedName = normalizeTypeName(resolvedName);

  return stripeCatalogConfig.primaryMembershipTypes.some((typeName) => {
    return normalizeTypeName(typeName) === normalizedResolvedName;
  });
}

export function getRegistrationTypeStripeConfig(regTypeName) {
  const resolvedName = resolveRegistrationTypeAlias(regTypeName);
  if (!resolvedName) {
    return null;
  }

  if (stripeCatalogConfig.priceMap[resolvedName]) {
    return stripeCatalogConfig.priceMap[resolvedName];
  }

  const normalizedResolvedName = normalizeTypeName(resolvedName);
  const matchedEntry = Object.entries(stripeCatalogConfig.priceMap).find(([typeName]) => {
    return normalizeTypeName(typeName) === normalizedResolvedName;
  });

  return matchedEntry ? matchedEntry[1] : null;
}

export function buildSubscriptionItemsFromRegistrationTypes({ primaryMembershipType, addonMembershipTypes }) {
  const items = [];
  const missingPriceMappings = [];

  const addMappedItem = (role, typeName) => {
    const stripeConfig = getRegistrationTypeStripeConfig(typeName);
    const resolvedTypeName = resolveRegistrationTypeAlias(typeName);

    if (!stripeConfig || !stripeConfig.priceId) {
      missingPriceMappings.push(typeName);
      return;
    }

    items.push({
      role,
      type_name: resolvedTypeName,
      source_type_name: typeName,
      price: stripeConfig.priceId,
    });
  };

  if (primaryMembershipType) {
    addMappedItem('primary', primaryMembershipType);
  }

  (Array.isArray(addonMembershipTypes) ? addonMembershipTypes : []).forEach((typeName) => {
    addMappedItem('addon', typeName);
  });

  return {
    items,
    missing_price_mappings: missingPriceMappings,
  };
}
