import type { Response } from 'express';
import type { ValidatedRequest } from '@/middleware/validate-request.js';
import { sendSuccess } from '@/shared/utils/api-response.js';
import { customersService } from './customers.service.js';
import type { ContactIdParams, CreateAccountInput, UpdateAccountInput } from './customers.validation.js';

class CustomersController {
  async getAccount(req: ValidatedRequest<{ params: ContactIdParams }>, res: Response) {
    const data = await customersService.getAccount({ organizationId: req.auth.organizationId, contactId: req.validated.params.contactId });
    return sendSuccess(res, { data });
  }

  async createAccount(req: ValidatedRequest<{ params: ContactIdParams; body: CreateAccountInput }>, res: Response) {
    const account = await customersService.createAccount({
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      contactId: req.validated.params.contactId,
      input: req.validated.body,
    });
    return sendSuccess(res, { statusCode: 201, message: 'Portal access created', data: account });
  }

  async updateAccount(req: ValidatedRequest<{ params: ContactIdParams; body: UpdateAccountInput }>, res: Response) {
    await customersService.updateAccount({
      organizationId: req.auth.organizationId,
      actorUserId: req.auth.userId,
      contactId: req.validated.params.contactId,
      input: req.validated.body,
    });
    return sendSuccess(res, { message: 'Portal access updated' });
  }
}

export const customersController = new CustomersController();
