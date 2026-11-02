import { and, eq, isNull } from 'drizzle-orm';
import { db, type DbExecutor } from '@/config/database.js';
import { contacts, customerAccounts, customerSessions, organizations } from '@/database/schema/index.js';

const publicAccount = {
  id: customerAccounts.id,
  email: customerAccounts.email,
  isActive: customerAccounts.isActive,
  lastLoginAt: customerAccounts.lastLoginAt,
  createdAt: customerAccounts.createdAt,
};

class CustomersRepository {
  async findContactId(organizationId: string, contactId: string) {
    const [contact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, contactId), isNull(contacts.deletedAt)));
    return contact;
  }

  async findPublicAccount(organizationId: string, contactId: string) {
    const [account] = await db
      .select(publicAccount)
      .from(customerAccounts)
      .where(and(eq(customerAccounts.organizationId, organizationId), eq(customerAccounts.contactId, contactId)));
    return account;
  }

  async findOrganizationSlug(organizationId: string) {
    const [organization] = await db.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, organizationId));
    return organization?.slug;
  }

  async findAccountIdByContact(organizationId: string, contactId: string) {
    const [account] = await db
      .select({ id: customerAccounts.id })
      .from(customerAccounts)
      .where(and(eq(customerAccounts.organizationId, organizationId), eq(customerAccounts.contactId, contactId)));
    return account;
  }

  async findAccountIdByEmail(organizationId: string, email: string) {
    const [account] = await db
      .select({ id: customerAccounts.id })
      .from(customerAccounts)
      .where(and(eq(customerAccounts.organizationId, organizationId), eq(customerAccounts.email, email)));
    return account;
  }

  async findAccountEmailByContact(organizationId: string, contactId: string) {
    const [account] = await db
      .select({ id: customerAccounts.id, email: customerAccounts.email })
      .from(customerAccounts)
      .where(and(eq(customerAccounts.organizationId, organizationId), eq(customerAccounts.contactId, contactId)));
    return account;
  }

  async createAccount(values: { organizationId: string; contactId: string; email: string; passwordHash: string }) {
    const [account] = await db
      .insert(customerAccounts)
      .values({ ...values, mustChangePassword: true })
      .returning(publicAccount);
    return account!;
  }

  async updateAccount(
    id: string,
    changes: { email?: string; isActive?: boolean; passwordHash?: string; mustChangePassword?: boolean },
    executor: DbExecutor = db,
  ) {
    await executor
      .update(customerAccounts)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(customerAccounts.id, id));
  }

  async deleteSessions(accountId: string, executor: DbExecutor = db) {
    await executor.delete(customerSessions).where(eq(customerSessions.customerAccountId, accountId));
  }
}

export const customersRepository = new CustomersRepository();
