// Two-factor integration test: enrolment, the login challenge, replay protection, lockout, recovery codes and admin reset, against a real database.
//
// Needs a REAL, MIGRATED, DISPOSABLE Postgres database. It is skipped unless TEST_DATABASE_URL is set.
//   bash:        TEST_DATABASE_URL=postgres://user:pass@localhost:5432/crm_test npm run test:integration
// NEVER point it at the dev database. It inserts uniquely-named organizations and deletes them (cascade) afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testUrl)('two-factor authentication (database)', () => {
  let db: typeof import('@/config/database.js').db;
  let pool: typeof import('@/config/database.js').pool;
  let s: typeof import('@/database/schema/index.js');
  let eq: typeof import('drizzle-orm').eq;
  let and: typeof import('drizzle-orm').and;
  let auth: typeof import('./auth.service.js').authService;
  let hashToken: typeof import('./auth.service.js').hashToken;
  let tf: typeof import('./two-factor.service.js').twoFactorService;
  let totp: typeof import('./totp.js');
  let challenge: typeof import('./challenge.js');
  let orgId: string;
  let otherOrgId: string;
  let slug: string;
  let tag: string;
  const password = 'Str0ng!Passw0rd#1';
  const meta = { userAgent: 'test', ipAddress: '127.0.0.1' };

  const code = async (message: Promise<unknown>) =>
    (
      (await message.then(
        () => null,
        (err: unknown) => err,
      )) as { code?: string; statusCode?: number } | null
    )?.code;
  const newUser = async (name: string, organization = orgId) => {
    const email = `${name}-${tag}@example.test`;
    const [user] = await db
      .insert(s.users)
      .values({ organizationId: organization, email, fullName: name, passwordHash: await (await import('@/shared/utils/password.js')).hashPassword(password) })
      .returning();
    return { id: user!.id, email };
  };
  const login = (email: string) => auth.login({ email, password, organizationSlug: slug }, meta);
  const sessionOf = async (userId: string) => await db.select().from(s.sessions).where(eq(s.sessions.userId, userId));
  // a valid code for "now plus k steps"; the window accepts k of -1, 0 or +1
  const codeFor = (secret: string, k = 0) => totp.hotp(secret, totp.stepAt(new Date()) + k);
  const forgetLastCode = (userId: string) => db.update(s.userTotp).set({ lastUsedStep: null }).where(eq(s.userTotp.userId, userId));

  // Takes a user all the way to "two-factor on", returning what they would have on their phone.
  async function enrol(userId: string, email: string) {
    const { secret } = await tf.setup({ userId, organizationId: orgId, email, password });
    const { recoveryCodes } = await tf.enable({ userId, organizationId: orgId, code: codeFor(secret), keepTokenHash: hashToken('keep') });
    await forgetLastCode(userId); // so the next test step can use a fresh code in this same 30-second window
    return { secret, recoveryCodes };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    ({ db, pool } = await import('@/config/database.js'));
    s = await import('@/database/schema/index.js');
    ({ eq, and } = await import('drizzle-orm'));
    ({ authService: auth, hashToken } = await import('./auth.service.js'));
    ({ twoFactorService: tf } = await import('./two-factor.service.js'));
    totp = await import('./totp.js');
    challenge = await import('./challenge.js');

    tag = crypto.randomUUID().slice(0, 8);
    slug = `tf-${tag}`;
    const orgs = await db
      .insert(s.organizations)
      .values([
        { name: `tf-${tag}`, slug },
        { name: `tf2-${tag}`, slug: `tf2-${tag}` },
      ])
      .returning();
    orgId = orgs[0]!.id;
    otherOrgId = orgs[1]!.id;
  });

  afterAll(async () => {
    await db.delete(s.organizations).where(eq(s.organizations.id, orgId));
    await db.delete(s.organizations).where(eq(s.organizations.id, otherOrgId));
    await pool.end();
  });

  it('leaves login exactly as it was for anyone who has not turned two-factor on', async () => {
    const u = await newUser('plain');
    const result = await login(u.email);
    expect(result).toHaveProperty('session.token');
    expect(result).not.toHaveProperty('challengeToken');
    expect(await tf.status(u.id)).toEqual({ enabled: false, setupPending: false, recoveryCodesRemaining: 0 });
  });

  it('asks for the password again before setup, and stores the seed encrypted', async () => {
    const u = await newUser('setup');
    expect(await code(tf.setup({ userId: u.id, organizationId: orgId, email: u.email, password: 'wrong' }))).toBe('INVALID_PASSWORD');
    const { secret, otpauthUrl } = await tf.setup({ userId: u.id, organizationId: orgId, email: u.email, password });
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUrl).toContain(`secret=${secret}`);
    expect(otpauthUrl).toContain(encodeURIComponent(u.email));
    const [row] = await db.select().from(s.userTotp).where(eq(s.userTotp.userId, u.id));
    expect(row!.secretCiphertext).toMatch(/^v1\./);
    expect(row!.secretCiphertext).not.toContain(secret);
    expect(await tf.status(u.id)).toMatchObject({ enabled: false, setupPending: true });
    expect(await tf.isEnabled(u.id)).toBe(false); // scanned but not proved: logins are unaffected
    expect(await login(u.email)).toHaveProperty('session');
  });

  it('switches on only after a right code, shows ten recovery codes once and signs out other sessions', async () => {
    const u = await newUser('enable');
    const first = await login(u.email);
    const second = await login(u.email);
    const { secret } = await tf.setup({ userId: u.id, organizationId: orgId, email: u.email, password });

    expect(await code(tf.enable({ userId: u.id, organizationId: orgId, code: '000000', keepTokenHash: hashToken('x') }))).toBe('INVALID_CODE');
    expect(await tf.isEnabled(u.id)).toBe(false);
    const keep = 'session' in first ? first.session!.token : '';
    const { recoveryCodes } = await tf.enable({ userId: u.id, organizationId: orgId, code: codeFor(secret), keepTokenHash: hashToken(keep) });

    expect(recoveryCodes).toHaveLength(10);
    expect(await tf.status(u.id)).toEqual({ enabled: true, setupPending: false, recoveryCodesRemaining: 10 });
    const remaining = await sessionOf(u.id);
    expect(remaining.map((r) => r.tokenHash)).toEqual([hashToken(keep)]); // the other login was ended
    expect('session' in second).toBe(true);
    const stored = await db.select().from(s.userRecoveryCodes).where(eq(s.userRecoveryCodes.userId, u.id));
    expect(JSON.stringify(stored)).not.toContain(recoveryCodes[0]!); // only hashes are kept
    expect(await code(tf.setup({ userId: u.id, organizationId: orgId, email: u.email, password }))).toBe('TWO_FACTOR_ALREADY_ON');
  });

  it('login now ends in a challenge, and the session only comes with a valid, unused code', async () => {
    const u = await newUser('login');
    const { secret } = await enrol(u.id, u.email);

    const result = await login(u.email);
    expect(result).toHaveProperty('challengeToken');
    expect(await sessionOf(u.id)).toHaveLength(0); // no session was created by the password alone
    const challengeToken = ('challengeToken' in result ? result.challengeToken : '') as string;

    expect(await code(auth.completeTwoFactorLogin({ challengeToken, code: '123456' }, meta))).toBe('INVALID_CODE');
    const session = await auth.completeTwoFactorLogin({ challengeToken, code: codeFor(secret, 1) }, meta);
    expect(session.token).toHaveLength(64);
    expect(await sessionOf(u.id)).toHaveLength(1);

    // the same code cannot be used twice, nor can an older one
    expect(await code(auth.completeTwoFactorLogin({ challengeToken, code: codeFor(secret, 1) }, meta))).toBe('INVALID_CODE');
    expect(await code(auth.completeTwoFactorLogin({ challengeToken, code: codeFor(secret, 0) }, meta))).toBe('INVALID_CODE');
  });

  it('refuses a forged, expired or foreign challenge, and one for a deactivated user', async () => {
    const u = await newUser('challenge');
    const { secret } = await enrol(u.id, u.email);
    const { env } = await import('@/config/env.js');
    expect(await code(auth.completeTwoFactorLogin({ challengeToken: 'garbage', code: codeFor(secret) }, meta))).toBe('INVALID_CHALLENGE');
    expect(
      await code(
        auth.completeTwoFactorLogin({ challengeToken: challenge.issueChallenge(u.id, 'another-secret-another-secret-12345'), code: codeFor(secret) }, meta),
      ),
    ).toBe('INVALID_CHALLENGE');
    expect(
      await code(
        auth.completeTwoFactorLogin({ challengeToken: challenge.issueChallenge(u.id, env.JWT_SECRET, Date.now() - 10 * 60_000), code: codeFor(secret) }, meta),
      ),
    ).toBe('INVALID_CHALLENGE');

    const fresh = tf.challengeFor(u.id);
    await db.update(s.users).set({ isActive: false }).where(eq(s.users.id, u.id));
    expect(await code(auth.completeTwoFactorLogin({ challengeToken: fresh, code: codeFor(secret) }, meta))).toBe('INVALID_CHALLENGE');
    await db.update(s.users).set({ isActive: true }).where(eq(s.users.id, u.id));
  });

  it('locks after five wrong codes, even for the right code, until the lock passes', async () => {
    const u = await newUser('lock');
    const { secret } = await enrol(u.id, u.email);
    const challengeToken = tf.challengeFor(u.id);

    for (let i = 0; i < 4; i++) expect(await code(auth.completeTwoFactorLogin({ challengeToken, code: '000000' }, meta))).toBe('INVALID_CODE');
    expect(await code(auth.completeTwoFactorLogin({ challengeToken, code: '000000' }, meta))).toBe('RATE_LIMITED'); // the fifth locks
    expect(await code(auth.completeTwoFactorLogin({ challengeToken, code: codeFor(secret) }, meta))).toBe('RATE_LIMITED'); // the right code is refused too

    await db
      .update(s.userTotp)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(s.userTotp.userId, u.id));
    expect((await auth.completeTwoFactorLogin({ challengeToken, code: codeFor(secret) }, meta)).token).toBeTruthy();
    const [row] = await db.select().from(s.userTotp).where(eq(s.userTotp.userId, u.id));
    expect(row).toMatchObject({ failedAttempts: 0, lockedUntil: null }); // a success clears the count
  });

  it('a recovery code signs in once, in any case and with or without the dash', async () => {
    const u = await newUser('recover');
    const { recoveryCodes } = await enrol(u.id, u.email);
    const challengeToken = tf.challengeFor(u.id);
    const typed = recoveryCodes[0]!.toLowerCase().replace('-', ' ');

    expect((await auth.completeTwoFactorLogin({ challengeToken, recoveryCode: typed }, meta)).token).toBeTruthy();
    expect(await code(auth.completeTwoFactorLogin({ challengeToken, recoveryCode: typed }, meta))).toBe('INVALID_CODE'); // used up
    expect(await code(auth.completeTwoFactorLogin({ challengeToken, recoveryCode: 'AAAAA-BBBBB' }, meta))).toBe('INVALID_CODE');
    expect((await tf.status(u.id)).recoveryCodesRemaining).toBe(9);
  });

  it('two people never share a second factor', async () => {
    const a = await newUser('alice');
    const b = await newUser('bob');
    const alice = await enrol(a.id, a.email);
    await enrol(b.id, b.email);
    expect(await code(auth.completeTwoFactorLogin({ challengeToken: tf.challengeFor(b.id), code: codeFor(alice.secret) }, meta))).toBe('INVALID_CODE');
    expect(await code(auth.completeTwoFactorLogin({ challengeToken: tf.challengeFor(b.id), recoveryCode: alice.recoveryCodes[0]! }, meta))).toBe(
      'INVALID_CODE',
    );
  });

  it('regenerating recovery codes retires the old set; it needs the password and a current code', async () => {
    const u = await newUser('regen');
    const { secret, recoveryCodes } = await enrol(u.id, u.email);
    expect(await code(tf.regenerateRecoveryCodes({ userId: u.id, organizationId: orgId, password: 'wrong', code: codeFor(secret) }))).toBe('INVALID_PASSWORD');
    expect(await code(tf.regenerateRecoveryCodes({ userId: u.id, organizationId: orgId, password, code: '000000' }))).toBe('INVALID_CODE');
    const fresh = await tf.regenerateRecoveryCodes({ userId: u.id, organizationId: orgId, password, code: codeFor(secret) });
    expect(fresh.recoveryCodes).toHaveLength(10);
    expect(await code(auth.completeTwoFactorLogin({ challengeToken: tf.challengeFor(u.id), recoveryCode: recoveryCodes[0]! }, meta))).toBe('INVALID_CODE');
    expect((await auth.completeTwoFactorLogin({ challengeToken: tf.challengeFor(u.id), recoveryCode: fresh.recoveryCodes[0]! }, meta)).token).toBeTruthy();
  });

  it('turning it off needs the password and a second factor, and logins go back to normal', async () => {
    const u = await newUser('off');
    const { secret, recoveryCodes } = await enrol(u.id, u.email);
    expect(await code(tf.disable({ userId: u.id, organizationId: orgId, password: 'wrong', factor: { code: codeFor(secret) } }))).toBe('INVALID_PASSWORD');
    expect(await code(tf.disable({ userId: u.id, organizationId: orgId, password, factor: { code: '000000' } }))).toBe('INVALID_CODE');
    expect(await tf.isEnabled(u.id)).toBe(true);
    await tf.disable({ userId: u.id, organizationId: orgId, password, factor: { recoveryCode: recoveryCodes[1]! } }); // a recovery code works as the second factor
    expect(await tf.status(u.id)).toEqual({ enabled: false, setupPending: false, recoveryCodesRemaining: 0 });
    expect(await login(u.email)).toHaveProperty('session');
  });

  it('an administrator can reset it for someone who lost their phone, within the organization only', async () => {
    const user = await newUser('lost');
    const admin = await newUser('admin');
    const foreigner = await newUser('foreign', otherOrgId);
    await enrol(user.id, user.email);
    await enrol(foreigner.id, foreigner.email);

    expect(await code(tf.adminReset({ organizationId: orgId, actorId: admin.id, targetUserId: foreigner.id }))).toBe('NOT_FOUND');
    expect(await tf.isEnabled(foreigner.id)).toBe(true);
    await tf.adminReset({ organizationId: orgId, actorId: admin.id, targetUserId: user.id });
    expect(await tf.isEnabled(user.id)).toBe(false);
    expect(await login(user.email)).toHaveProperty('session');
    const audit = await db
      .select()
      .from(s.auditLogs)
      .where(and(eq(s.auditLogs.organizationId, orgId), eq(s.auditLogs.targetId, user.id)));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['user.two_factor_enabled', 'user.two_factor_reset']));
  });
});
