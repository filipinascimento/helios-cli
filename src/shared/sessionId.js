import crypto from 'node:crypto';

export function createSessionId() {
  return crypto.randomBytes(6).toString('hex');
}
