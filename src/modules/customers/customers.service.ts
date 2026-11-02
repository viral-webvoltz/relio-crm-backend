import { audit } from '@/shared/utils/audit.js';
import { hashPassword } from '@/shared/utils/password.js';
import { withTransaction } from '@/config/database.js';
import { ConflictError, NotFoundError } from '@/shared/errors/index.js';
import { customersRepository } from './customers.repository.js';
import type { CreateAccountInput, UpdateAccountInput } from './customers.validation.js';

class CustomersService {
  private async assertContact(organizationId: string, contactId: string) {
    if (!(await customersRepository.findContactId(organizationId, contactId))) throw new NotFoundError('Contact not found');
  }

  async getAccount({ organizationId, contactId }: { organizationId: string; contactId: string }) {
    await this.assertContact(organizationId, contactId);
    const account = await customersRepository.findPublicAccount(organizationId, contactId);
    const organizationSlug = await customersRepository.findOrganizationSlug(organizationId);
    if (!organizationSlug) throw new NotFoundError('Organization not found');
    return { account: account ?? null, organizationSlug };
  }

  async createAccount({
    organizationId,
    actorUserId,
    contactId,
    input,
  }: {
    organizationId: string;
    actorUserId: string;
    contactId: string;
    input: CreateAccountInput;
  }) {
    await this.assertContact(organizationId, contactId);
    if (await customersRepository.findAccountIdByContact(organizationId, contactId))
      throw new ConflictError('This contact already has portal access', 'ACCOUNT_EXISTS');
    if (await customersRepository.findAccountIdByEmail(organizationId, input.email))
      throw new ConflictError('Another customer already uses this email', 'EMAIL_TAKEN');

    const account = await customersRepository.createAccount({
      organizationId,
      contactId,
      email: input.email,
      passwordHash: await hashPassword(input.password),
    });
    await audit({
      organizationId,
      actorUserId,
      action: 'portal_account.created',
      targetType: 'customer_account',
      targetId: account.id,
      metadata: { contactId },
    });
    return account;
  }

  async updateAccount({
    organizationId,
    actorUserId,
    contactId,
    input,
  }: {
    organizationId: string;
    actorUserId: string;
    contactId: string;
    input: UpdateAccountInput;
  }) {
    const account = await customersRepository.findAccountEmailByContact(organizationId, contactId);
    if (!account) throw new NotFoundError('This contact has no portal access');
    if (input.email && input.email !== account.email && (await customersRepository.findAccountIdByEmail(organizationId, input.email))) {
      throw new ConflictError('Another customer already uses this email', 'EMAIL_TAKEN');
    }

    const changes = {
      ...(input.email && { email: input.email }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      ...(input.password && { passwordHash: await hashPassword(input.password), mustChangePassword: true }),
    };
    await withTransaction(async (tx) => {
      await customersRepository.updateAccount(account.id, changes, tx);
      if (input.password || input.isActive === false) await customersRepository.deleteSessions(account.id, tx);
    });
    await audit({
      organizationId,
      actorUserId,
      action: input.password ? 'portal_account.password_reset' : 'portal_account.updated',
      targetType: 'customer_account',
      targetId: account.id,
      metadata: { contactId, isActive: input.isActive, email: input.email },
    });
  }
}

export const customersService = new CustomersService();
