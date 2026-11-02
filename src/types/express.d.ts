import type { AuthContext } from '@/shared/types/auth.js';
import type { AuthCustomer } from '@/modules/portal/portal.auth.js';

declare global {
  namespace Express {
    interface Request {
      // Set by `authenticate`; only read on routes behind it.
      auth: AuthContext;
      // Set by `authenticateCustomer` on portal routes.
      customer: AuthCustomer;
      // Set by `validateRequest`. Typed `never` so a controller method declaring ValidatedRequest<...> is accepted by the router;
      // read it only through that type.
      validated: { body: never; query: never; params: never };
    }
  }
}
