import { createHmac } from 'crypto';

export interface SessionPayload {
  projectId: string;
  username: string;
  projectName: string;
}

const encode = (p: SessionPayload) => Buffer.from(JSON.stringify(p)).toString('base64url');
const decode = (s: string): SessionPayload => JSON.parse(Buffer.from(s, 'base64url').toString());

export const signSession = (payload: SessionPayload, secret: string): string => {
  const data = encode(payload);
  const sig  = createHmac('sha256', secret).update(data).digest('hex');
  return `${data}.${sig}`;
};

export const verifySession = (cookie: string | undefined, secret: string): SessionPayload | null => {
  if (!cookie) return null;
  const dot = cookie.lastIndexOf('.');
  if (dot === -1) return null;
  const data = cookie.slice(0, dot);
  const sig  = cookie.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(data).digest('hex');
  // Constant-time comparison
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  try { return decode(data); } catch { return null; }
};
