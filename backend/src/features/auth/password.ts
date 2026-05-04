// Password hashing wrapper.
//
// `Bun.password.hash` returns the full PHC-format encoded string, e.g.
//   $argon2id$v=19$m=65536,t=2,p=1$<base64 salt>$<base64 hash>
// — algorithm, version, parameters, salt, and digest all in one string. We
// store that whole blob in `users.password_hash`. `verify()` parses the prefix
// and uses the embedded parameters, so re-hashing with stronger parameters
// later is just a code change here, not a schema migration.
//
// Argon2id over bcrypt: argon2id is the OWASP-recommended default in 2025+;
// it's memory-hard, which makes GPU/ASIC attacks much more expensive than
// bcrypt's purely CPU-bound work factor. Bun ships argon2id natively (via Zig)
// so there's no `node-argon2` native-build pain.
//
// Parameters: we pass `algorithm: 'argon2id'` explicitly. Memory cost,
// time cost, and parallelism use Bun's defaults, which target ~50ms hash time
// on modern hardware — slow enough to throttle attackers, fast enough that
// login isn't user-visibly slow. If we ever tune, this is the single seam.

const ALGORITHM = 'argon2id' as const;

export const hashPassword = async (plaintext: string): Promise<string> => {
  // Bun.password.hash is async — internally it dispatches to a thread so we
  // don't block the event loop while argon2 churns through ~64 MB of memory.
  return await Bun.password.hash(plaintext, ALGORITHM);
};

export const verifyPassword = async (plaintext: string, hash: string): Promise<boolean> => {
  // Bun.password.verify is constant-time relative to the hash content, so a
  // wrong-but-correct-length password takes the same time as a right one;
  // no timing oracle on individual users. It also auto-detects the algorithm
  // from the hash prefix, so we don't pass it in here.
  return await Bun.password.verify(plaintext, hash);
};
