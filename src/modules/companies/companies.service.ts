import { NotFoundError } from '@/shared/errors/index.js';
import type { ListQuery } from '@/shared/pagination/index.js';
import { companiesRepository } from './companies.repository.js';
import type { CreateCompanyInput, UpdateCompanyInput, BatchCompaniesInput } from './companies.validation.js';
import { runBatch } from '@/shared/batch/index.js';

class CompaniesService {
  list({ organizationId, query }: { organizationId: string; query: ListQuery }) {
    return companiesRepository.list({ organizationId, query });
  }

  async get({ organizationId, id }: { organizationId: string; id: string }) {
    const company = await companiesRepository.findById({ organizationId, id });
    if (!company) throw new NotFoundError('Company not found');
    return company;
  }

  create({ organizationId, input }: { organizationId: string; input: CreateCompanyInput }) {
    return companiesRepository.create({ organizationId, input });
  }

  async update({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateCompanyInput }) {
    const company = await companiesRepository.update({ organizationId, id, input });
    if (!company) throw new NotFoundError('Company not found');
    return company;
  }

  // Soft delete: related tasks and activity stay, so a restore brings everything back.
  async remove({ organizationId, id, userId }: { organizationId: string; id: string; userId: string }) {
    if (!(await companiesRepository.remove({ organizationId, id, userId }))) throw new NotFoundError('Company not found');
  }

  listDeleted({ organizationId, query }: { organizationId: string; query: ListQuery }) {
    return companiesRepository.listDeleted({ organizationId, query });
  }

  async restore({ organizationId, id }: { organizationId: string; id: string }) {
    const company = await companiesRepository.restore({ organizationId, id });
    if (!company) throw new NotFoundError('Deleted company not found');
    return company;
  }

  // Same code path as the single-record endpoints, one item at a time.
  batch({ organizationId, userId, input }: { organizationId: string; userId: string; input: BatchCompaniesInput }) {
    return runBatch(input.ids, (id) =>
      input.action === 'delete' ? this.remove({ organizationId, id, userId }) : this.update({ organizationId, id, input: input.changes }),
    );
  }
}

export const companiesService = new CompaniesService();
