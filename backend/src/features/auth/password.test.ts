import { describe, expect, test } from 'bun:test';
import { hashPassword, verifyPassword } from './password.ts';

describe('password', () => {
  test('hashPassword returns a PHC-format argon2id string', async () => {
    const hash = await hashPassword('correct horse battery staple');
    // PHC format: $argon2id$v=<version>$m=<mem>,t=<time>,p=<parallel>$<salt>$<digest>
    // We only assert the algorithm prefix — internals are Bun-managed defaults
    // and we deliberately don't pin them here.
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  test('hashes are non-deterministic (random salt)', async () => {
    // Same plaintext, hashed twice, must yield different strings — otherwise
    // the salt isn't doing its job and an attacker could precompute rainbow
    // tables. This is a regression guard against accidentally swapping in a
    // deterministic hash.
    const a = await hashPassword('same-input');
    const b = await hashPassword('same-input');
    expect(a).not.toBe(b);
  });

  test('verifyPassword returns true for the right plaintext', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  test('verifyPassword returns false for the wrong plaintext', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });
});
