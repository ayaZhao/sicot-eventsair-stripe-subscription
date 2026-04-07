export const stripeCatalogConfig = {
  mode: 'live',
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
    'Associate Member Free': 'Associate Member',
  },

  priceMap: {
    'Active Member': {
      role: 'primary',
      priceId: 'price_1TChVeCsrIQtLPXlQFSZJCgT',
    },
    'Active Member - Discounted': {
      role: 'primary',
      priceId: 'price_1TI2CoCsrIQtLPXlF71mYvL8',
    },
    'Active Member - EU': {
      role: 'primary',
      priceId: 'price_1TI2DTCsrIQtLPXlE5I0EA7b',
    },
    'Associate Member': {
      role: 'primary',
      priceId: 'price_1TI0wdCsrIQtLPXlfbxAsJAE',
    },
    'Associate Member - Discounted': {
      role: 'primary',
      priceId: 'price_1TI2ZSCsrIQtLPXlWvj834yo',
    },
    'Associate Member - EU': {
      role: 'primary',
      priceId: 'price_1TI2ZmCsrIQtLPXll3pT4doD',
    },
    'Corresponding Member (JOA)': {
      role: 'primary',
      priceId: 'price_1TI2aJCsrIQtLPXlLfbgH8rf',
    },
    'Corresponding Member (SIOT)': {
      role: 'primary',
      priceId: 'price_1TI2adCsrIQtLPXlhJxC4PUw',
    },
    'Corresponding Member (SOFCOT)': {
      role: 'primary',
      priceId: 'price_1TI2apCsrIQtLPXlCbMkbLH8',
    },
    'Emeritus Member - International Orthopaedics Journal Subscription': {
      role: 'primary',
      priceId: 'price_1TI0yACsrIQtLPXlbMdlp010',
    },
    'National Fund - France': {
      role: 'addon',
      priceId: 'price_1TI0z3CsrIQtLPXlOLdUR4f2',
    },
    'National Fund - Japan': {
      role: 'addon',
      priceId: 'price_1TI0zYCsrIQtLPXl12FM8jTg',
    },
    'National Fund - United Kingdom': {
      role: 'addon',
      priceId: 'price_1TI10VCsrIQtLPXluzgS9U4z',
    },
    'National Fund - United States': {
      role: 'addon',
      priceId: 'price_1TI12dCsrIQtLPXlYKFz3V31',
    },
    'SICOT CONECT - Digital Orthopaedics & AI': {
      role: 'addon',
      priceId: 'price_1TI13LCsrIQtLPXlecz06bHa',
    },
    'SICOT CONECT - Digital Orthopaedics & AI - Discounted': {
      role: 'addon',
      priceId: 'price_1TI2oCCsrIQtLPXlkhwuQWy1',
    },
    'SICOT CONECT - Foot & Ankle': {
      role: 'addon',
      priceId: 'price_1TI13lCsrIQtLPXlXQpEub2y',
    },
    'SICOT CONECT - Foot & Ankle - Discounted': {
      role: 'addon',
      priceId: 'price_1TI2bHCsrIQtLPXlemRp5GKi',
    },
    'SICOT CONECT - Hand': {
      role: 'addon',
      priceId: 'price_1TI155CsrIQtLPXlVpjIgc1T',
    },
    'SICOT CONECT - Hand - Discounted': {
      role: 'addon',
      priceId: 'price_1TI2bdCsrIQtLPXlFOkZTVQf',
    },
    'SICOT CONECT - Hip': {
      role: 'addon',
      priceId: 'price_1TI15oCsrIQtLPXlxjnmb5yr',
    },
    'SICOT CONECT - Hip - Discounted': {
      role: 'addon',
      priceId: 'price_1TI2buCsrIQtLPXl8WrsAoBS',
    },
    'SICOT CONECT - Infections': {
      role: 'addon',
      priceId: 'price_1TI16oCsrIQtLPXlcFKwuPkh',
    },
    'SICOT CONECT - Infections - Discounted': {
      role: 'addon',
      priceId: 'price_1TI2cECsrIQtLPXlSbOUh5ub',
    },
    'SICOT CONECT - Knee': {
      role: 'addon',
      priceId: 'price_1TI17iCsrIQtLPXlVi4qHxbU',
    },
    'SICOT CONECT - Knee - Discounted': {
      role: 'addon',
      priceId: 'price_1TI2cZCsrIQtLPXlO1Ifaj6S',
    },
    'SICOT CONECT - Limb Reconstruction': {
      role: 'addon',
      priceId: 'price_1TI18bCsrIQtLPXlMplpbMgW',
    },
    'SICOT CONECT - Limb Reconstruction - Discounted': {
      role: 'addon',
      priceId: 'price_1TI2d1CsrIQtLPXlzzwdr8ab',
    },
    'SICOT CONECT - Orthopaedic Microsurgery': {
      role: 'addon',
      priceId: 'price_1TI19ZCsrIQtLPXl9yRh9gzV',
    },
    'SICOT CONECT - Orthopaedic Microsurgery - Discounted': {
      role: 'addon',
      priceId: 'price_1TI2dLCsrIQtLPXlF1i4OzNV',
    },
    'SICOT CONECT - Orthopaedic Rehabilitation': {
      role: 'addon',
      priceId: 'price_1TI1AaCsrIQtLPXlRM3hAvow',
    },
    'SICOT CONECT - Orthopaedic Rehabilitation - Discounted': {
      role: 'addon',
      priceId: 'price_1TI2deCsrIQtLPXlThFXr3Ru',
    },
    'SICOT CONECT - Paediatrics': {
      role: 'addon',
      priceId: 'price_1TI1AvCsrIQtLPXlpIF4bQsa',
    },
    'SICOT CONECT - Paediatrics - Discounted': {
      role: 'addon',
      priceId: 'price_1TI2dvCsrIQtLPXlHrYW9MqK',
    },
    'SICOT CONECT - Shoulder & Elbow': {
      role: 'addon',
      priceId: 'price_1TI1BtCsrIQtLPXlH2riA6jZ',
    },
    'SICOT CONECT - Shoulder & Elbow - Discounted': {
      role: 'addon',
      priceId: 'price_1TI2eECsrIQtLPXl3ixIlWY3',
    },
    'SICOT CONECT - Spine': {
      role: 'addon',
      priceId: 'price_1TI1CdCsrIQtLPXla7P6uYGc',
    },
    'SICOT CONECT - Spine - Discounted': {
      role: 'addon',
      priceId: 'price_1TI2eZCsrIQtLPXlZB6j1Z1S',
    },
    'SICOT CONECT - Sports Traumatology & Arthroscopy': {
      role: 'addon',
      priceId: 'price_1TI1CwCsrIQtLPXlO6sVJr88',
    },
    'SICOT CONECT - Sports Traumatology & Arthroscopy - Discounted': {
      role: 'addon',
      priceId: 'price_1TI2eyCsrIQtLPXlXwlIrQ6J',
    },
    'SICOT CONECT - Trauma': {
      role: 'addon',
      priceId: 'price_1TI1DsCsrIQtLPXlrtuOGMhX',
    },
    'SICOT CONECT - Trauma - Discounted': {
      role: 'addon',
      priceId: 'price_1TI2fHCsrIQtLPXl4b7G0DCc',
    },
    'SICOT CONECT - Tumours': {
      role: 'addon',
      priceId: 'price_1TI1EDCsrIQtLPXlSwZ6AaYt',
    },
    'SICOT CONECT - Tumours - Discounted': {
      role: 'addon',
      priceId: 'price_1TI2fdCsrIQtLPXlCGB0tOBT',
    },
  },
};
