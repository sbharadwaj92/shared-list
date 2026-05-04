import { describe, expect, test } from 'bun:test';
import { z } from '@hono/zod-openapi';
import { flattenIssues } from './validation-hook.ts';

// Unit tests for `flattenIssues`. The integration test in
// `auth/integration.test.ts` covers the end-to-end "Hono returns the right
// envelope" path; these tests pin down the message-shaping logic in
// isolation so we can iterate on the format without restarting Postgres.

describe('flattenIssues', () => {
  test('returns "invalid request" for non-ZodError input', () => {
    expect(flattenIssues(null)).toBe('invalid request');
    expect(flattenIssues({})).toBe('invalid request');
    expect(flattenIssues({ issues: [] })).toBe('invalid request');
  });

  test('formats a single field issue as "<path>: <message>"', () => {
    // We construct a real ZodError by parsing a known-bad value rather
    // than hand-rolling an `issues` array. This guards against future
    // zod-version changes to the issue shape.
    const schema = z.object({ password: z.string().min(12) });
    const result = schema.safeParse({ password: 'short' });
    expect(result.success).toBe(false);
    if (result.success) return;

    const message = flattenIssues(result.error);
    expect(message).toContain('password');
    // Default zod min-string message is "Too small: expected string to have >=12 characters"
    // (or similar across versions); we just assert the field name is there.
  });

  test('joins multiple issues with semicolons', () => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(12),
    });
    const result = schema.safeParse({ email: 'not-an-email', password: 'short' });
    expect(result.success).toBe(false);
    if (result.success) return;

    const message = flattenIssues(result.error);
    expect(message).toContain('email');
    expect(message).toContain('password');
    expect(message).toContain(';');
  });

  test('uses "body" as the path label when issue.path is empty', () => {
    // A top-level type mismatch (e.g. string passed where object expected)
    // produces an issue with an empty path array. The fallback label keeps
    // the message readable instead of starting with a colon.
    const schema = z.object({ a: z.string() });
    const result = schema.safeParse('not an object');
    expect(result.success).toBe(false);
    if (result.success) return;

    const message = flattenIssues(result.error);
    expect(message).toMatch(/^body:/);
  });
});
