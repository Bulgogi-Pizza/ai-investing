import { describe, expect, it } from 'vitest';
import { hashPassword, sessionHash, validCredentials, verifyPassword } from '../src/server/auth';
describe('password and session protection', () => {
  it('uses distinct salts and verifies without storing plaintext', async () => {
    const first = await hashPassword('Correct horse battery');
    const second = await hashPassword('Correct horse battery');
    expect(first).not.toEqual(second);
    expect(first).not.toContain('Correct horse');
    expect(await verifyPassword('Correct horse battery', first)).toBe(true);
    expect(await verifyPassword('Incorrect horse battery', first)).toBe(false);
    expect(await verifyPassword('anything', 'broken')).toBe(false);
    expect(sessionHash('opaque-token')).not.toContain('opaque-token');
  });
  it('caps hashing inputs at the primitive boundary', async () => {
    await expect(hashPassword('x'.repeat(257))).rejects.toThrow();
    await expect(hashPassword('short')).rejects.toThrow();
  });
  it('rejects short, oversized and malformed credentials', () => {
    expect(validCredentials('user@example.com', 'short')).toBe(false);
    expect(validCredentials('user@example.com', 'x'.repeat(257))).toBe(false);
    expect(validCredentials('invalid', 'x'.repeat(12))).toBe(false);
  });
});
