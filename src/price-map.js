import 'dotenv/config';
import {
  getRegistrationTypeStripeConfig,
  resolveRegistrationTypeAlias,
} from './registration-type-map.js';

function normalizeTypeName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function getConfiguredRegTypePriceMap() {
  const rawValue = process.env.STRIPE_REG_TYPE_PRICE_MAP;
  if (!rawValue) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.entries(parsed).reduce((result, [typeName, priceId]) => {
      const normalizedTypeName = normalizeTypeName(typeName);
      if (!normalizedTypeName || typeof priceId !== 'string' || !priceId.trim()) {
        return result;
      }

      result[normalizedTypeName] = priceId.trim();
      return result;
    }, {});
  } catch (error) {
    throw new Error(`STRIPE_REG_TYPE_PRICE_MAP is not valid JSON: ${error.message}`);
  }
}

export function getPriceIdForRegTypeName(regTypeName) {
  const resolvedTypeName = resolveRegistrationTypeAlias(regTypeName);
  const normalizedTypeName = normalizeTypeName(resolvedTypeName);
  if (!normalizedTypeName) {
    return null;
  }

  const fileMappedConfig = getRegistrationTypeStripeConfig(resolvedTypeName);
  if (fileMappedConfig && fileMappedConfig.stripe_price_id) {
    return fileMappedConfig.stripe_price_id;
  }
  if (fileMappedConfig && fileMappedConfig.priceId) {
    return fileMappedConfig.priceId;
  }

  const configuredMap = getConfiguredRegTypePriceMap();
  if (configuredMap[normalizedTypeName]) {
    return configuredMap[normalizedTypeName];
  }

  const fallbackMap = {
    'active member': process.env.STRIPE_PRICE_ACTIVE_YEARLY,
    'associate membership': process.env.STRIPE_PRICE_ASSOCIATE_YEARLY,
  };

  return fallbackMap[normalizedTypeName] || null;
}

export function getPriceIdForMembershipType(membershipType) {
  const map = {
    active: process.env.STRIPE_PRICE_ACTIVE_YEARLY,
    associate: process.env.STRIPE_PRICE_ASSOCIATE_YEARLY,
  };

  return map[membershipType] || null;
}

export function buildSubscriptionItemsFromRegTypes({ primaryMembershipType, addonMembershipTypes }) {
  const items = [];
  const missingPriceMappings = [];

  if (primaryMembershipType) {
    const priceId = getPriceIdForRegTypeName(primaryMembershipType);
    if (priceId) {
      items.push({
        role: 'primary',
        type_name: primaryMembershipType,
        price: priceId,
      });
    } else {
      missingPriceMappings.push(primaryMembershipType);
    }
  }

  (Array.isArray(addonMembershipTypes) ? addonMembershipTypes : []).forEach((typeName) => {
    const priceId = getPriceIdForRegTypeName(typeName);
    if (priceId) {
      items.push({
        role: 'addon',
        type_name: typeName,
        price: priceId,
      });
      return;
    }

    missingPriceMappings.push(typeName);
  });

  return {
    items,
    missing_price_mappings: missingPriceMappings,
  };
}
