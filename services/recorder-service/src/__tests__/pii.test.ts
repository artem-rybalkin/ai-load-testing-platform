import { describe, it, expect } from 'vitest';
import { redactPII, detectPII } from '@alt/shared';

describe('redactPII', () => {
  it('redacts email addresses', () => {
    expect(redactPII('contact me at jane.doe@example.com please'))
      .toBe('contact me at [REDACTED_EMAIL] please');
  });

  it('redacts SSNs', () => {
    expect(redactPII('SSN: 123-45-6789')).toBe('SSN: [REDACTED_SSN]');
  });

  it('redacts phone numbers', () => {
    expect(redactPII('call 555-123-4567 now')).toBe('call [REDACTED_PHONE] now');
  });

  it('redacts valid credit card numbers (Luhn-valid)', () => {
    // 4111111111111111 is a well-known Luhn-valid test Visa number
    expect(redactPII('card: 4111111111111111')).toBe('card: [REDACTED_CARD]');
  });

  it('does not redact arbitrary numeric IDs that fail the Luhn check', () => {
    expect(redactPII('user_id: 1234567890123456')).toBe('user_id: 1234567890123456');
  });

  it('redacts IPv4 addresses', () => {
    expect(redactPII('client ip 192.168.1.100 connected')).toBe('client ip [REDACTED_IP] connected');
  });

  it('redacts multiple categories in the same string', () => {
    const input = 'email jane@example.com from 10.0.0.1, ssn 123-45-6789';
    expect(redactPII(input)).toBe('email [REDACTED_EMAIL] from [REDACTED_IP], ssn [REDACTED_SSN]');
  });

  it('leaves text without PII unchanged', () => {
    const input = '{"access_token":"abc123","user_id":42}';
    expect(redactPII(input)).toBe(input);
  });

  it('handles empty string', () => {
    expect(redactPII('')).toBe('');
  });
});

describe('detectPII', () => {
  it('detects email addresses', () => {
    expect(detectPII('contact jane@example.com')).toContain('email');
  });

  it('detects credit card numbers', () => {
    expect(detectPII('4111111111111111')).toContain('creditCard');
  });

  it('returns empty array when no PII present', () => {
    expect(detectPII('{"access_token":"abc123"}')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(detectPII('')).toEqual([]);
  });
});
