// Documents integration test: attachments, versions, permissions per record type, isolation and the storage cap, against a real database.
//
// Needs a REAL, MIGRATED, DISPOSABLE Postgres database. It is skipped unless TEST_DATABASE_URL is set.
//   bash:        TEST_DATABASE_URL=postgres://user:pass@localhost:5432/crm_test npm run test:integration
// NEVER point it at the dev database. It inserts uniquely-named organizations and deletes them (cascade) afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testUrl)('documents (database)', () => {
  let db: typeof import('@/config/database.js').db;
  let pool: typeof import('@/config/database.js').pool;
  let s: typeof import('@/database/schema/index.js');
  let eq: typeof import('drizzle-orm').eq;
  let and: typeof import('drizzle-orm').and;
  let svc: typeof import('./documents.service.js').documentsService;
  let limit: number;
  let orgId: string;
  let otherOrgId: string;
  let userId: string;
  let contactId: string;
  let invoiceId: string;
  let otherContactId: string;

  const all = ['documents.view', 'documents.create', 'documents.delete', 'contacts.view', 'invoices.view'];
  const as = (permissions: string[], organization = orgId) => ({ organizationId: organization, userId, permissions });
  const bytes = (text: string) => Buffer.from(text);
  const upload = (extra: Record<string, unknown> = {}) =>
    svc.upload({
      caller: as(all),
      entityType: 'contact',
      entityId: contactId,
      name: 'Contract',
      fileName: 'contract.pdf',
      mimeType: 'application/pdf',
      content: bytes('v1 bytes'),
      ...extra,
    } as never);
  const code = async (work: Promise<unknown>) =>
    (
      (await work.then(
        () => null,
        (err: unknown) => err,
      )) as { code?: string } | null
    )?.code;

  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    ({ db, pool } = await import('@/config/database.js'));
    s = await import('@/database/schema/index.js');
    ({ eq, and } = await import('drizzle-orm'));
    const mod = await import('./documents.service.js');
    svc = mod.documentsService;
    limit = mod.ORG_STORAGE_BYTES;

    const tag = crypto.randomUUID().slice(0, 8);
    const orgs = await db
      .insert(s.organizations)
      .values([
        { name: `doc-${tag}`, slug: `doc-${tag}` },
        { name: `doc2-${tag}`, slug: `doc2-${tag}` },
      ])
      .returning();
    orgId = orgs[0]!.id;
    otherOrgId = orgs[1]!.id;
    userId = (
      await db
        .insert(s.users)
        .values({ organizationId: orgId, email: `doc-${tag}@example.test`, fullName: 'Filer', passwordHash: 'x' })
        .returning()
    )[0]!.id;
    contactId = (await db.insert(s.contacts).values({ organizationId: orgId, firstName: 'Dee' }).returning())[0]!.id;
    otherContactId = (await db.insert(s.contacts).values({ organizationId: otherOrgId, firstName: 'Other' }).returning())[0]!.id;
    const [order] = await db.insert(s.orders).values({ organizationId: orgId, orderNumber: 1, currency: 'USD', totalMinor: 100 }).returning();
    invoiceId = (
      await db
        .insert(s.invoices)
        .values({ organizationId: orgId, invoiceNumber: 1, orderId: order!.id, currency: 'USD', totalMinor: 100, dueDate: '2030-01-01' })
        .returning()
    )[0]!.id;
  });

  afterAll(async () => {
    await db.delete(s.organizations).where(eq(s.organizations.id, orgId));
    await db.delete(s.organizations).where(eq(s.organizations.id, otherOrgId));
    await pool.end();
  });

  it('attaches a file to a record, lists it, and downloads exactly the bytes that went in', async () => {
    const payload = Buffer.from([0, 1, 2, 250, 255, 10, 13, 0]); // not text: bytes must survive untouched; the name loses its separator and control characters (it is never used as a path)
    const doc = await upload({ content: payload, fileName: '../evil\u0000name.pdf' });
    expect(doc).toMatchObject({ entityType: 'contact', entityId: contactId, name: 'Contract', currentVersion: 1 });

    const listed = await svc.list({ caller: as(all), entityType: 'contact', entityId: contactId });
    expect(listed.find((d) => d.id === doc.id)).toMatchObject({
      fileName: '..evilname.pdf',
      sizeBytes: 8,
      mimeType: 'application/pdf',
      uploadedByName: 'Filer',
    });
    expect(JSON.stringify(listed)).not.toContain('content'); // listing never carries file bytes
    const file = await svc.download({ caller: as(all), id: doc.id });
    expect(Buffer.compare(file.content, payload)).toBe(0);
    expect(file).toMatchObject({ fileName: '..evilname.pdf', mimeType: 'application/pdf' });
  });

  it('rejects an empty file and a record that does not exist or belongs to another organization', async () => {
    expect(await code(upload({ content: Buffer.alloc(0) }))).toBe('EMPTY_FILE');
    expect(await code(upload({ entityId: crypto.randomUUID() }))).toBe('NOT_FOUND');
    expect(await code(upload({ entityId: otherContactId }))).toBe('NOT_FOUND');
  });

  it('needs the right to see the record: a document is only as visible as what it is attached to', async () => {
    const doc = await upload();
    const invoiceDoc = await upload({ entityType: 'invoice', entityId: invoiceId, name: 'Receipt' });
    const noContacts = as(['documents.view', 'documents.create', 'invoices.view']);
    const noInvoices = as(['documents.view', 'documents.create', 'contacts.view']);

    expect(await code(svc.list({ caller: noContacts, entityType: 'contact', entityId: contactId }))).toBe('FORBIDDEN');
    expect(await code(svc.get({ caller: noContacts, id: doc.id }))).toBe('FORBIDDEN');
    expect(await code(svc.download({ caller: noContacts, id: doc.id }))).toBe('FORBIDDEN');
    expect(await code(svc.remove({ caller: noContacts, id: doc.id }))).toBe('FORBIDDEN');
    expect(
      await code(
        svc.upload({
          caller: noContacts,
          entityType: 'contact',
          entityId: contactId,
          name: 'x',
          fileName: 'x.pdf',
          mimeType: 'application/pdf',
          content: bytes('x'),
        }),
      ),
    ).toBe('FORBIDDEN');
    expect(await code(svc.download({ caller: noInvoices, id: invoiceDoc.id }))).toBe('FORBIDDEN');
    expect((await svc.download({ caller: noInvoices, id: doc.id })).fileName).toBe('contract.pdf'); // contacts are fine for them
  });

  it('keeps organizations apart', async () => {
    const doc = await upload();
    const outsider = as(all, otherOrgId);
    expect(await code(svc.get({ caller: outsider, id: doc.id }))).toBe('NOT_FOUND');
    expect(await code(svc.download({ caller: outsider, id: doc.id }))).toBe('NOT_FOUND');
    expect(await code(svc.rename({ caller: outsider, id: doc.id, name: 'x' }))).toBe('NOT_FOUND');
    expect(await code(svc.remove({ caller: outsider, id: doc.id }))).toBe('NOT_FOUND');
    expect(await code(svc.addVersion({ caller: outsider, id: doc.id, fileName: 'x.pdf', mimeType: 'application/pdf', content: bytes('x') }))).toBe('NOT_FOUND');
    expect(await svc.list({ caller: outsider, entityType: 'contact', entityId: contactId })).toEqual([]);
  });

  it('keeps every version: the newest is current and the older ones stay downloadable', async () => {
    const doc = await upload({ content: bytes('first') });
    const updated = await svc.addVersion({ caller: as(all), id: doc.id, fileName: 'contract-v2.pdf', mimeType: 'application/pdf', content: bytes('second') });
    expect(updated.currentVersion).toBe(2);

    expect((await svc.download({ caller: as(all), id: doc.id })).content.toString()).toBe('second');
    expect((await svc.download({ caller: as(all), id: doc.id, version: 1 })).content.toString()).toBe('first');
    expect(await code(svc.download({ caller: as(all), id: doc.id, version: 9 }))).toBe('NOT_FOUND');
    const detail = await svc.get({ caller: as(all), id: doc.id });
    expect(detail.versions.map((v) => [v.version, v.fileName])).toEqual([
      [2, 'contract-v2.pdf'],
      [1, 'contract.pdf'],
    ]);
    const listed = (await svc.list({ caller: as(all), entityType: 'contact', entityId: contactId })).find((d) => d.id === doc.id);
    expect(listed).toMatchObject({ currentVersion: 2, fileName: 'contract-v2.pdf' });
  });

  it('numbers versions without gaps under simultaneous uploads', async () => {
    const doc = await upload();
    await Promise.all(
      [1, 2, 3, 4].map((n) => svc.addVersion({ caller: as(all), id: doc.id, fileName: `f${n}.pdf`, mimeType: 'application/pdf', content: bytes(`v${n}`) })),
    );
    const versions = (await svc.get({ caller: as(all), id: doc.id })).versions.map((v) => v.version);
    expect(versions).toEqual([5, 4, 3, 2, 1]);
  });

  it('caps the number of versions of one document', async () => {
    const doc = await upload();
    await db.update(s.documents).set({ currentVersion: 50 }).where(eq(s.documents.id, doc.id));
    expect(await code(svc.addVersion({ caller: as(all), id: doc.id, fileName: 'x.pdf', mimeType: 'application/pdf', content: bytes('x') }))).toBe(
      'TOO_MANY_VERSIONS',
    );
  });

  it('stops uploads once the organization storage is full, and reports usage', async () => {
    const doc = await upload();
    const before = await svc.storageUsed(orgId);
    expect(before.limitBytes).toBe(limit);
    expect(before.usedBytes).toBeGreaterThan(0);

    // one tiny row that claims to fill the rest of the allowance
    const [filler] = await db
      .insert(s.documentVersions)
      .values({
        organizationId: orgId,
        documentId: doc.id,
        version: 999,
        fileName: 'f',
        mimeType: 'text/plain',
        sizeBytes: limit - before.usedBytes - 5,
        content: bytes('x'),
      })
      .returning();
    expect(await code(upload())).toBe('STORAGE_FULL');
    await db.delete(s.documentVersions).where(eq(s.documentVersions.id, filler!.id));
    expect((await upload()).id).toBeTruthy(); // room again
  });

  it('renames and deletes a document with all its versions, and writes audit entries', async () => {
    const doc = await upload();
    await svc.addVersion({ caller: as(all), id: doc.id, fileName: 'b.pdf', mimeType: 'application/pdf', content: bytes('b') });
    expect((await svc.rename({ caller: as(all), id: doc.id, name: 'Renamed' })).name).toBe('Renamed');

    await svc.remove({ caller: as(all), id: doc.id });
    expect(await code(svc.get({ caller: as(all), id: doc.id }))).toBe('NOT_FOUND');
    expect(await db.select().from(s.documentVersions).where(eq(s.documentVersions.documentId, doc.id))).toEqual([]);
    const actions = (
      await db
        .select()
        .from(s.auditLogs)
        .where(and(eq(s.auditLogs.organizationId, orgId), eq(s.auditLogs.targetId, contactId)))
    ).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['document.uploaded', 'document.version_added', 'document.deleted']));
  });
});
