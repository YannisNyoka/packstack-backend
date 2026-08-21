// Normalizes a customer-entered phone number to a canonical E.164-ish string
// so the same real number always produces the same Customer.phone value -
// this matters now that signup "claims" an existing anonymous booking record
// by exact phone match (see customerAuthService.js#signUpCustomer). Without
// this, "0821234567" and "+27821234567" would silently create two separate
// Customer docs for the same person.
//
// Deliberately not a full phone-validation library (e.g. libphonenumber-js) -
// this product's tenants are South African salons taking WhatsApp/phone
// bookings, so a small ZA-biased normalizer covers the real cases without a
// new dependency. Anything already in +<countrycode> form is left as-is.
const DEFAULT_COUNTRY_CODE = '27'; // South Africa

export function normalizePhone(raw) {
  if (typeof raw !== 'string') return raw;

  const digits = raw.replace(/[^\d+]/g, '');
  if (!digits) return raw.trim();

  if (digits.startsWith('+')) {
    return `+${digits.slice(1).replace(/\D/g, '')}`;
  }
  if (digits.startsWith('00')) {
    return `+${digits.slice(2)}`;
  }
  if (digits.startsWith('0')) {
    // Local ZA format, e.g. 0821234567 -> +27821234567
    return `+${DEFAULT_COUNTRY_CODE}${digits.slice(1)}`;
  }
  if (digits.startsWith(DEFAULT_COUNTRY_CODE)) {
    return `+${digits}`;
  }
  return `+${digits}`;
}
