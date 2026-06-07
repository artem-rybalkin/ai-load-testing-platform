import { describe, it, expect } from 'vitest';
import { signSession, verifySession, SessionPayload } from '../session';

const SECRET = 'test-secret-key';

const payload: SessionPayload = {
  projectId: 'proj-uuid-123',
  username: 'alice',
  projectName: 'my-project',
};

describe('signSession', () => {
  it('produces a string with two dot-separated parts', () => {
    const token = signSession(payload, SECRET);
    const parts = token.split('.');
    expect(parts.length).toBe(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  it('encodes the payload in the first part (base64url)', () => {
    const token = signSession(payload, SECRET);
    const dataPart = token.split('.')[0];
    const decoded = JSON.parse(Buffer.from(dataPart, 'base64url').toString());
    expect(decoded).toEqual(payload);
  });

  it('produces different tokens for different secrets', () => {
    const t1 = signSession(payload, 'secret-a');
    const t2 = signSession(payload, 'secret-b');
    expect(t1).not.toBe(t2);
  });
});

describe('verifySession', () => {
  it('returns the payload for a valid signed token', () => {
    const token = signSession(payload, SECRET);
    const result = verifySession(token, SECRET);
    expect(result).toEqual(payload);
  });

  it('returns null when cookie is undefined', () => {
    expect(verifySession(undefined, SECRET)).toBeNull();
  });

  it('returns null when cookie is an empty string', () => {
    expect(verifySession('', SECRET)).toBeNull();
  });

  it('returns null when there is no dot separator', () => {
    expect(verifySession('nodothere', SECRET)).toBeNull();
  });

  it('returns null when the signature is tampered', () => {
    const token = signSession(payload, SECRET);
    const tampered = token.slice(0, -4) + 'xxxx';
    expect(verifySession(tampered, SECRET)).toBeNull();
  });

  it('returns null when verified with a different secret', () => {
    const token = signSession(payload, SECRET);
    expect(verifySession(token, 'different-secret')).toBeNull();
  });

  it('returns null when the data portion is invalid base64url', () => {
    const fakeToken = '!!!invalid!!!.somesignature';
    expect(verifySession(fakeToken, SECRET)).toBeNull();
  });

  it('returns null when the signature length does not match expected', () => {
    const token = signSession(payload, SECRET);
    const [data] = token.split('.');
    const shortSig = token + '.extra'; // makes the sig too long
    expect(verifySession(`${data}.short`, SECRET)).toBeNull();
  });
});
