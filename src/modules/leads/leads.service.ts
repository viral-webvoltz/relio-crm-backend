import { withTransaction } from '@/config/database.js';
import { isUniqueViolation } from '@/database/soft-delete.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/shared/errors/index.js';
import { assignmentService } from '@/modules/assignment/assignment.service.js';
import { customFieldsService } from '@/modules/custom-fields/custom-fields.service.js';
import { leadsRepository } from './leads.repository.js';
import type { CreateLeadInput, LeadListQuery, UpdateLeadInput, BatchLeadsInput } from './leads.validation.js';
import { runBatch } from '@/shared/batch/index.js';

class LeadsService {
  async list({ organizationId, query }: { organizationId: string; query: LeadListQuery }) {
    await customFieldsService.assertFilterKeys({ organizationId, entityType: 'lead', cf: query.cf });
    return leadsRepository.list({ organizationId, query });
  }

  async get({ organizationId, id }: { organizationId: string; id: string }) {
    const lead = await leadsRepository.findById({ organizationId, id });
    if (!lead) throw new NotFoundError('Lead not found');
    return lead;
  }

  async create({ organizationId, input, canAssign }: { organizationId: string; input: CreateLeadInput; canAssign: boolean }) {
    if (input.assignedTo && !canAssign) throw new ForbiddenError('You cannot assign leads', 'FORBIDDEN');
    await this.assertAssignee({ organizationId, assignedTo: input.assignedTo });
    const customFields = await customFieldsService.resolve({ organizationId, entityType: 'lead', input: input.customFields, partial: false });
    // Nobody chosen: let the assignment rules route it (never fails the create; an unmatched lead stays unassigned).
    const routed = input.assignedTo === undefined ? await assignmentService.safePick({ organizationId, resource: 'leads', values: input }) : null;
    const lead = await leadsRepository.create({ organizationId, input: { ...input, customFields, ...(routed && { assignedTo: routed.userId }) } });
    if (routed) await assignmentService.tell(organizationId, 'leads', lead.id, routed.userId, [lead.firstName, lead.lastName].filter(Boolean).join(' '));
    return lead;
  }

  async update({ organizationId, id, input, canAssign }: { organizationId: string; id: string; input: UpdateLeadInput; canAssign: boolean }) {
    if (input.assignedTo !== undefined && !canAssign) throw new ForbiddenError('You cannot assign leads', 'FORBIDDEN');
    await this.assertAssignee({ organizationId, assignedTo: input.assignedTo });
    const existing = await this.get({ organizationId, id });
    if (existing.status === 'converted') throw new ConflictError('Converted leads cannot be edited', 'LEAD_CONVERTED');
    const customFields = await customFieldsService.resolve({ organizationId, entityType: 'lead', input: input.customFields, partial: true });
    const lead = await leadsRepository.update({ organizationId, id, input: { ...input, customFields } });
    if (!lead) throw new NotFoundError('Lead not found');
    return lead;
  }

  // Soft delete: related tasks and activity stay, so a restore brings everything back.
  async remove({ organizationId, id, userId }: { organizationId: string; id: string; userId: string }) {
    if (!(await leadsRepository.remove({ organizationId, id, userId }))) throw new NotFoundError('Lead not found');
  }

  listDeleted({ organizationId, query }: { organizationId: string; query: ListQuery }) {
    return leadsRepository.listDeleted({ organizationId, query });
  }

  async restore({ organizationId, id }: { organizationId: string; id: string }) {
    const lead = await leadsRepository.restore({ organizationId, id }).catch((error: unknown) => {
      if (isUniqueViolation(error)) throw new ConflictError('Lead can no longer be restored: a unique value was reused', 'RESTORE_CONFLICT');
      throw error;
    });
    if (!lead) throw new NotFoundError('Deleted lead not found');
    return lead;
  }

  // Converts once: the row lock serialises concurrent requests, and an existing contact with the same email is reused.
  convert({ organizationId, id }: { organizationId: string; id: string }) {
    return withTransaction(async (tx) => {
      const lead = await leadsRepository.findByIdForUpdate({ organizationId, id }, tx);
      if (!lead) throw new NotFoundError('Lead not found');
      if (lead.status === 'converted') throw new ConflictError('Lead is already converted', 'LEAD_CONVERTED');

      const existing = lead.email ? await leadsRepository.findContactByEmail({ organizationId, email: lead.email }, tx) : null;
      const contact = existing ?? (await leadsRepository.createContactFromLead({ organizationId, lead }, tx));

      await leadsRepository.markConverted({ id, contactId: contact.id }, tx);
      return contact;
    });
  }

  private async assertAssignee({ organizationId, assignedTo }: { organizationId: string; assignedTo?: string | null }) {
    if (assignedTo && !(await leadsRepository.userExists({ organizationId, userId: assignedTo }))) {
      throw new BadRequestError('Assignee not found', 'INVALID_ASSIGNEE');
    }
  }

  // Same code path as the single-record endpoints, one item at a time.
  batch({ organizationId, userId, input, canAssign }: { organizationId: string; userId: string; input: BatchLeadsInput; canAssign: boolean }) {
    return runBatch(input.ids, (id) =>
      input.action === 'delete' ? this.remove({ organizationId, id, userId }) : this.update({ organizationId, id, input: input.changes, canAssign }),
    );
  }
}

export const leadsService = new LeadsService();
