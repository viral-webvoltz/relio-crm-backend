// API keys integration test: creation, hash-only storage, scopes cut down to the owner's rights, revocation, expiry and the authenticate middleware,
// against a real database.
//
// Needs a REAL, MIGRATED, DISPOSABLE Postgres database. It is skipped unless TEST_DATABASE_URL is set.
//   bash:        TEST_DATABASE_URL=postgres://user:pass@localhost:5432/crm_test npm run test:integration
// NEVER point it at the dev database. It inserts uniquely-named organizations and deletes them (cascade) afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testUrl)('API keys (database)', () => {
  let db: typeof import('@/config/database.js').db;
  let pool: typeof import('@/config/database.js').pool;
  let s: typeof import('@/database/schema/index.js');
  let eq: typeof import('drizzle-orm').eq;
  let and: typeof import('drizzle-orm').and;
  let svc: typeof import('./api-keys.service.js').apiKeysService;
  let schemas: typeof import('./api-keys.validation.js');
  let authenticate: typeof import('@/middleware/authenticate.js').authenticate;
  let sessionOnly: typeof import('@/middleware/session-only.js').sessionOnly;
  let hashToken: typeof import('@/modules/auth/auth.service.js').hashToken;
  let orgId: string;
  let otherOrgId: string;
  let userId: string;
  let roleId: string;
  let viewId: string;
  let createId: string;
  const owner = ['contacts.view', 'contacts.create', 'deals.view', 'settings.manage', 'users.manage'];

  const make = (extra: Record<string, unknown> = {}) =>
    svc.create({ organizationId: orgId, userId, permissions: owner, input: { name: 'Zapier', scopes: ['contacts.view'], ...extra } as never });
  const code = async (work: Promise<unknown>) =>
    (
      (await work.then(
        () => null,
        (err: unknown) => err,
      )) as { code?: string } | null
    )?.code;
  const row = async (id: string) => (await db.select().from(s.apiKeys).where(eq(s.apiKeys.id, id)))[0]!;

  // Runs the real middleware against a fake request.
  async function run(headers: Record<string, string>, cookies: Record<string, string> = {}) {
    const req = { cookies, get: (name: string) => headers[name.toLowerCase()], auth: undefined as never } as never as import('express').Request;
    let outcome: unknown = 'pending';
    // typed as returning void, but it is an async function: its rejection is the 401
    const done = authenticate(req, { setHeader() {} } as never, (err?: unknown) => (outcome = err ?? 'next')) as unknown as Promise<void>;
    await done.catch((err: unknown) => (outcome = err));
    return { req, outcome: outcome as { code?: string } | 'next' };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    ({ db, pool } = await import('@/config/database.js'));
    s = await import('@/database/schema/index.js');
    ({ eq, and } = await import('drizzle-orm'));
    ({ apiKeysService: svc } = await import('./api-keys.service.js'));
    schemas = await import('./api-keys.validation.js');
    ({ authenticate } = await import('@/middleware/authenticate.js'));
    ({ sessionOnly } = await import('@/middleware/session-only.js'));
    ({ hashToken } = await import('@/modules/auth/auth.service.js'));

    const tag = crypto.randomUUID().slice(0, 8);
    const orgs = await db
      .insert(s.organizations)
      .values([
        { name: `ak-${tag}`, slug: `ak-${tag}` },
        { name: `ak2-${tag}`, slug: `ak2-${tag}` },
      ])
      .returning();
    orgId = orgs[0]!.id;
    otherOrgId = orgs[1]!.id;
    userId = (
      await db
        .insert(s.users)
        .values({ organizationId: orgId, email: `ak-${tag}@example.test`, fullName: 'Key Owner', passwordHash: 'x' })
        .returning()
    )[0]!.id;

    await db
      .insert(s.permissions)
      .values(['contacts.view', 'contacts.create', 'deals.view'].map((key) => ({ key })))
      .onConflictDoNothing();
    const perms = await db.select().from(s.permissions);
    const id = (key: string) => perms.find((p) => p.key === key)!.id;
    [viewId, createId] = [id('contacts.view'), id('contacts.create')];
    roleId = (
      await db
        .insert(s.roles)
        .values({ organizationId: orgId, name: `keys-${tag}` })
        .returning()
    )[0]!.id;
    await db.insert(s.rolePermissions).values([viewId, createId, id('deals.view')].map((permissionId) => ({ roleId, permissionId })));
    await db.insert(s.userRoles).values({ userId, roleId });
  });

  afterAll(async () => {
    await db.delete(s.organizations).where(eq(s.organizations.id, orgId));
    await db.delete(s.organizations).where(eq(s.organizations.id, otherOrgId));
    await pool.end();
  });

  it('never offers the management rights as scopes, and only what the caller can do themselves', () => {
    expect(schemas.grantableScopes).not.toContain('settings.manage');
    expect(schemas.grantableScopes).not.toContain('users.manage');
    expect(svc.scopesFor(owner)).toEqual(['contacts.view', 'contacts.create', 'deals.view']);
    expect(schemas.createApiKeySchema.safeParse({ name: 'x', scopes: ['settings.manage'] }).success).toBe(false);
    expect(schemas.createApiKeySchema.safeParse({ name: 'x', scopes: ['users.manage'] }).success).toBe(false);
    expect(schemas.createApiKeySchema.safeParse({ name: 'x', scopes: [] }).success).toBe(false);
    expect(schemas.createApiKeySchema.safeParse({ name: 'x', scopes: ['contacts.view', 'contacts.view'] }).success).toBe(false);
    expect(schemas.createApiKeySchema.safeParse({ name: 'x', scopes: ['contacts.view'], expiresInDays: 9999 }).success).toBe(false);
  });

  it('creates a key shown once: only its hash is stored and listings never carry it', async () => {
    const created = await make({ name: 'Billing sync' });
    expect(created.key).toMatch(/^crm_[A-Za-z0-9_-]{43}$/);
    expect(created.keyPrefix).toBe(created.key.slice(0, 12));
    const stored = await row(created.id);
    expect(stored.keyHash).toBe(hashToken(created.key));
    expect(JSON.stringify(stored)).not.toContain(created.key);

    const listed = await svc.list(orgId);
    expect(JSON.stringify(listed)).not.toContain(created.key);
    expect(JSON.stringify(listed)).not.toContain(stored.keyHash);
    expect(listed.find((k) => k.id === created.id)).toMatchObject({
      name: 'Billing sync',
      keyPrefix: created.keyPrefix,
      scopes: ['contacts.view'],
      createdByName: 'Key Owner',
      revokedAt: null,
    });
    expect(await svc.list(otherOrgId)).toEqual([]);
  });

  it('refuses to give a key rights the creator does not have', async () => {
    expect(
      await code(
        svc.create({ organizationId: orgId, userId, permissions: ['contacts.view'], input: { name: 'x', scopes: ['contacts.view', 'deals.view'] } as never }),
      ),
    ).toBe('FORBIDDEN');
  });

  it('a key works with its scopes, cut down to what its owner can still do', async () => {
    const created = await make({ scopes: ['contacts.view', 'contacts.create'] });
    const found = await svc.authenticate(created.key);
    expect(found).toMatchObject({ userId, organizationId: orgId, keyId: created.id });
    expect(found!.permissions.sort()).toEqual(['contacts.create', 'contacts.view']);
    expect((await row(created.id)).lastUsedAt).not.toBeNull();

    // the owner loses a right: the key loses it too, at once
    await db.delete(s.rolePermissions).where(and(eq(s.rolePermissions.roleId, roleId), eq(s.rolePermissions.permissionId, createId)));
    expect((await svc.authenticate(created.key))!.permissions).toEqual(['contacts.view']);
    await db.insert(s.rolePermissions).values({ roleId, permissionId: createId });
  });

  it('refuses unknown, malformed, revoked, expired keys and keys whose owner is gone, all the same way', async () => {
    expect(await svc.authenticate('crm_' + 'x'.repeat(43))).toBeNull();
    expect(await svc.authenticate('not-a-key')).toBeNull();
    expect(await svc.authenticate('crm_' + 'x'.repeat(500))).toBeNull();

    const revoked = await make();
    await svc.revoke({ organizationId: orgId, userId, id: revoked.id });
    expect(await svc.authenticate(revoked.key)).toBeNull();
    expect(await code(svc.revoke({ organizationId: orgId, userId, id: revoked.id }))).toBe('NOT_FOUND'); // already revoked
    expect(await code(svc.revoke({ organizationId: otherOrgId, userId, id: (await make()).id }))).toBe('NOT_FOUND'); // another organization's key

    const expiring = await make({ expiresInDays: 1 });
    expect(await svc.authenticate(expiring.key)).not.toBeNull();
    await db
      .update(s.apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(s.apiKeys.id, expiring.id));
    expect(await svc.authenticate(expiring.key)).toBeNull();

    const orphaned = await make();
    await db.update(s.users).set({ isActive: false }).where(eq(s.users.id, userId));
    expect(await svc.authenticate(orphaned.key)).toBeNull();
    await db.update(s.users).set({ isActive: true }).where(eq(s.users.id, userId));
    expect(await svc.authenticate(orphaned.key)).not.toBeNull();
  });

  it('caps the number of active keys, and revoking one makes room', async () => {
    const live = (await svc.list(orgId)).filter((k) => !k.revokedAt).length;
    const created = [];
    for (let i = live; i < 25; i++) created.push(await make({ name: `bulk ${i}` }));
    expect(await code(make())).toBe('TOO_MANY_KEYS');
    await svc.revoke({ organizationId: orgId, userId, id: created[0]!.id });
    const room = await make();
    expect(room.key).toBeTruthy();
    // leave a few free slots for the tests that follow
    for (const k of [room, created[1]!, created[2]!]) await svc.revoke({ organizationId: orgId, userId, id: k.id });
  });

  it('the authenticate middleware accepts a bearer key and rejects everything else', async () => {
    const created = await make({ scopes: ['contacts.view'] });
    const ok = await run({ authorization: `Bearer ${created.key}` });
    expect(ok.outcome).toBe('next');
    expect(ok.req.auth).toMatchObject({ userId, organizationId: orgId, apiKeyId: created.id, permissions: ['contacts.view'] });

    for (const authorization of ['', 'Bearer ', 'Bearer crm_nope', `Basic ${created.key}`, created.key]) {
      const bad = await run(authorization ? { authorization } : {});
      expect(typeof bad.outcome === 'object' ? bad.outcome.code : bad.outcome).toBe('UNAUTHENTICATED');
    }
    const revoked = await make();
    await svc.revoke({ organizationId: orgId, userId, id: revoked.id });
    expect((await run({ authorization: `Bearer ${revoked.key}` })).outcome).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('the session-only guard turns away a key and lets a person through', () => {
    const through = (apiKeyId?: string) => {
      let outcome: unknown = 'pending';
      sessionOnly({ auth: { apiKeyId } } as never, {} as never, (err?: unknown) => (outcome = err ?? 'next'));
      return outcome as { code?: string } | 'next';
    };
    expect(through()).toBe('next');
    expect(through('some-key')).toMatchObject({ code: 'SESSION_REQUIRED' });
  });
});
