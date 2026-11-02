// Login integration test: one email in several organizations, with and without naming the organization, against a real database.
//
// Needs a REAL, MIGRATED, DISPOSABLE Postgres database. It is skipped unless TEST_DATABASE_URL is set.
//   bash:        TEST_DATABASE_URL=postgres://user:pass@localhost:5432/crm_test npm run test:integration
// NEVER point it at the dev database. It inserts uniquely-named organizations and deletes them (cascade) afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testUrl)('login across organizations (database)', () => {
  let db: typeof import('@/config/database.js').db;
  let pool: typeof import('@/config/database.js').pool;
  let s: typeof import('@/database/schema/index.js');
  let eq: typeof import('drizzle-orm').eq;
  let auth: typeof import('./auth.service.js').authService;
  let tag: string;
  let orgIds: string[] = [];
  const password = 'Str0ng!Passw0rd#1';
  const meta = { userAgent: 'test', ipAddress: '127.0.0.1' };

  const failure = async (promise: Promise<unknown>) =>
    (await promise.then(
      () => null,
      (err: unknown) => err,
    )) as { code?: string; statusCode?: number; errors?: { slug: string; name: string }[] } | null;

  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    ({ db, pool } = await import('@/config/database.js'));
    s = await import('@/database/schema/index.js');
    ({ eq } = await import('drizzle-orm'));
    ({ authService: auth } = await import('./auth.service.js'));
    const { hashPassword } = await import('@/shared/utils/password.js');

    tag = crypto.randomUUID().slice(0, 8);
    const orgs = await db
      .insert(s.organizations)
      .values([
        { name: `Team ${tag}`, slug: `team-${tag}` },
        { name: `Team ${tag} 2`, slug: `team-${tag}-2` },
        { name: `Solo ${tag}`, slug: `solo-${tag}` },
      ])
      .returning();
    orgIds = orgs.map((o) => o.id);
    const passwordHash = await hashPassword(password);
    const other = await hashPassword('An0ther!Passw0rd#2');
    await db.insert(s.users).values([
      { organizationId: orgIds[0]!, email: `shared-${tag}@example.test`, fullName: 'Shared A', passwordHash },
      { organizationId: orgIds[1]!, email: `shared-${tag}@example.test`, fullName: 'Shared B', passwordHash: other },
      { organizationId: orgIds[2]!, email: `solo-${tag}@example.test`, fullName: 'Solo', passwordHash },
      { organizationId: orgIds[0]!, email: `twice-${tag}@example.test`, fullName: 'Twice A', passwordHash },
      { organizationId: orgIds[1]!, email: `twice-${tag}@example.test`, fullName: 'Twice B', passwordHash },
    ]);
  });

  afterAll(async () => {
    for (const id of orgIds) await db.delete(s.organizations).where(eq(s.organizations.id, id));
    await pool.end();
  });

  it('lets a person with one account sign in with just email and password', async () => {
    expect(await auth.login({ email: `solo-${tag}@example.test`, password }, meta)).toHaveProperty('session');
  });

  it('accepts the slug, or the organization name in any case, when it is given', async () => {
    const email = `solo-${tag}@example.test`;
    expect(await auth.login({ email, password, organizationSlug: `solo-${tag}` }, meta)).toHaveProperty('session');
    expect(await auth.login({ email, password, organizationSlug: `SOLO ${tag}` }, meta)).toHaveProperty('session');
  });

  it('picks the right account when the password fits only one of several with that email', async () => {
    expect(await auth.login({ email: `shared-${tag}@example.test`, password }, meta)).toHaveProperty('session');
    expect(await auth.login({ email: `shared-${tag}@example.test`, password: 'An0ther!Passw0rd#2' }, meta)).toHaveProperty('session');
  });

  it('asks which organization when the password fits several, and says nothing before that', async () => {
    const err = await failure(auth.login({ email: `twice-${tag}@example.test`, password }, meta));
    expect(err?.statusCode).toBe(409);
    expect(err?.code).toBe('ORGANIZATION_REQUIRED');
    expect(err?.errors?.map((o) => o.slug).sort()).toEqual([`team-${tag}`, `team-${tag}-2`]);
    expect(await auth.login({ email: `twice-${tag}@example.test`, password, organizationSlug: `team-${tag}-2` }, meta)).toHaveProperty('session');
  });

  it('still answers a wrong password, an unknown email or a wrong organization the same way', async () => {
    for (const input of [
      { email: `solo-${tag}@example.test`, password: 'nope-nope-nope' },
      { email: `nobody-${tag}@example.test`, password },
      { email: `solo-${tag}@example.test`, password, organizationSlug: `team-${tag}` },
      { email: `twice-${tag}@example.test`, password: 'nope-nope-nope' },
    ]) {
      const err = await failure(auth.login(input, meta));
      expect([err?.statusCode, err?.code]).toEqual([401, 'INVALID_CREDENTIALS']);
    }
  });

  it('refuses a deactivated account', async () => {
    await db
      .update(s.users)
      .set({ isActive: false })
      .where(eq(s.users.email, `solo-${tag}@example.test`));
    const err = await failure(auth.login({ email: `solo-${tag}@example.test`, password }, meta));
    expect(err?.statusCode).toBe(401);
  });
});
