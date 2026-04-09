export const stripeCatalogConfig = {
  mode: 'test',
  primaryMembershipTypes: [
    'Active Member',
    'Active Member - Discounted',
    'Active Member - EU',
    'Associate Member',
    'Associate Member - Discounted',
    'Associate Member - EU',
    'Corresponding Member (JOA)',
    'Corresponding Member (SIOT)',
    'Corresponding Member (SOFCOT)',
    'Emeritus Member - International Orthopaedics Journal Subscription',
  ],

  aliases: {
    'Associate Membership': 'Associate Member',
    'Active Member Free': 'Active Member',
    'Active Member (Complimentary)': 'Active Member',
    'Active Member - Discounted (Complimentary)': 'Active Member - Discounted',
    'Active Member - EU (Complimentary)': 'Active Member - EU',
    'Associate Member Free': 'Associate Member',
    'Associate Member (Complimentary)': 'Associate Member',
    'Associate Member - Discounted (Complimentary)': 'Associate Member - Discounted',
    'Associate Member - EU (Complimentary)': 'Associate Member - EU',
  },

  priceMap: {
    'Active Member': {
      role: 'primary',
      priceId: 'price_1TF8EzCsrIQtLPXlG3RH6E8k',
    },
    'Active Member - Discounted': {
      role: 'primary',
      priceId: 'price_1TKFNkCsrIQtLPXlfyDuPeFQ',
    },
    'Active Member - EU': {
      role: 'primary',
      priceId: 'price_1TKFOZCsrIQtLPXlriBnny0E',
    },
    'Associate Member': {
      role: 'primary',
      priceId: 'price_1TF8FgCsrIQtLPXlddQ94zg0',
    },
    'Associate Member - Discounted': {
      role: 'primary',
      priceId: 'price_1TKFPJCsrIQtLPXlxb70biqB',
    },
    'Associate Member - EU': {
      role: 'primary',
      priceId: 'price_1TKFPxCsrIQtLPXlTjaNhGsm',
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
    'SICOT CONECT - Spine': {
      role: 'addon',
      priceId: 'price_1TKFvFCsrIQtLPXlk6MrpJyl',
    },
    'SICOT CONECT - Spine - Discounted': {
      role: 'addon',
      priceId: 'price_1TKFvZCsrIQtLPXljGvOtDsv',
    }
  },
};
