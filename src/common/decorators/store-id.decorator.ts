import {
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { JwtPayload } from './current-user.decorator';

/**
 * Extracts the authenticated user's `storeId`. Throws 403 if absent — guarantees
 * downstream services always operate against a concrete tenant.
 *
 * Pair with `TenantGuard` (which handles the SUPER_ADMIN bypass at the route
 * level). This decorator is the last line of defense for handlers that require
 * a concrete store.
 */
export const StoreId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<{ user?: JwtPayload }>();
    const storeId = request.user?.storeId;

    if (!storeId) {
      throw new ForbiddenException('Store context is required for this operation');
    }

    return storeId;
  },
);
