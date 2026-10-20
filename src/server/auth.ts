import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export const normalizeEmail = (value: string) => value.trim().toLowerCase();
export function validCredentials(email: unknown, password: unknown): email is string {
  return (
    typeof email === 'string' &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    typeof password === 'string' &&
    password.length >= 12 &&
    password.length <= 256
  );
}
export async function hashPassword(password: string) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256)
    throw new Error('Invalid password length');
  const salt = randomBytes(32).toString('hex');
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, salt, expected] = encoded.split(':');
  if (
    algorithm !== 'scrypt' ||
    !/^[a-f0-9]{64}$/.test(salt ?? '') ||
    !/^[a-f0-9]{128}$/.test(expected ?? '')
  )
    return false;
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return timingSafeEqual(hash, Buffer.from(expected, 'hex'));
}
export const sessionHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const createSessionToken = () => randomBytes(32).toString('base64url');
