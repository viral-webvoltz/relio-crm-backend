import { BadRequestError, ConflictError, NotFoundError } from '@/shared/errors/index.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import { isUniqueViolation } from '@/database/soft-delete.js';
import { customFieldsService } from '@/modules/custom-fields/custom-fields.service.js';
import { contactsRepository } from './contacts.repository.js';
import type { ContactListQuery, CreateContactInput, UpdateContactInput, BatchContactsInput } from './contacts.validation.js';
import { runBatch } from '@/shared/batch/index.js';

class ContactsService {
  async list({ organizationId, query }: { organizationId: string; query: ContactListQuery }) {
    await customFieldsService.assertFilterKeys({ organizationId, entityType: 'contact', cf: query.cf });
    return contactsRepository.list({ organizationId, query });
  }

  async get({ organizationId, id }: { organizationId: string; id: string }) {
    const contact = await contactsRepository.findById({ organizationId, id });
    if (!contact) throw new NotFoundError('Contact not found');
    return contact;
  }

  async create({ organizationId, input }: { organizationId: string; input: CreateContactInput }) {
    await this.assertValidReferences({ organizationId, input });
    const customFields = await customFieldsService.resolve({ organizationId, entityType: 'contact', input: input.customFields, partial: false });
    return contactsRepository.create({ organizationId, input: { ...input, customFields } });
  }

  async update({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateContactInput }) {
    await this.assertValidReferences({ organizationId, input, selfId: id });
    const customFields = await customFieldsService.resolve({ organizationId, entityType: 'contact', input: input.customFields, partial: true });
    const contact = await contactsRepository.update({ organizationId, id, input: { ...input, customFields } });
    if (!contact) throw new NotFoundError('Contact not found');
    return contact;
  }

  // Soft delete: related tasks and activity stay, so a restore brings everything back.
  async remove({ organizationId, id, userId }: { organizationId: string; id: string; userId: string }) {
    if (!(await contactsRepository.remove({ organizationId, id, userId }))) throw new NotFoundError('Contact not found');
  }

  listDeleted({ organizationId, query }: { organizationId: string; query: ListQuery }) {
    return contactsRepository.listDeleted({ organizationId, query });
  }

  async restore({ organizationId, id }: { organizationId: string; id: string }) {
    const contact = await contactsRepository.restore({ organizationId, id }).catch((error: unknown) => {
      if (isUniqueViolation(error)) throw new ConflictError('Contact can no longer be restored: its email is used by another contact', 'RESTORE_CONFLICT');
      throw error;
    });
    if (!contact) throw new NotFoundError('Deleted contact not found');
    return contact;
  }

  // The unique index is the real guard against races; these checks give clear errors.
  private async assertValidReferences({ organizationId, input, selfId }: { organizationId: string; input: UpdateContactInput; selfId?: string }) {
    if (input.companyId && !(await contactsRepository.companyExists({ organizationId, companyId: input.companyId }))) {
      throw new BadRequestError('Company not found', 'INVALID_COMPANY');
    }
    if (input.email) {
      const duplicate = await contactsRepository.findByEmail({ organizationId, email: input.email });
      if (duplicate && duplicate.id !== selfId) throw new ConflictError('A contact with this email already exists', 'DUPLICATE_CONTACT');
    }
  }

  // Same code path as the single-record endpoints, one item at a time.
  batch({ organizationId, userId, input }: { organizationId: string; userId: string; input: BatchContactsInput }) {
    return runBatch(input.ids, (id) =>
      input.action === 'delete' ? this.remove({ organizationId, id, userId }) : this.update({ organizationId, id, input: input.changes }),
    );
  }
}

export const contactsService = new ContactsService();
