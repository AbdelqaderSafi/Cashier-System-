import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtPayload } from '../decorators/current-user.decorator';

/**
 * Guards tenant-scoped routes by ensuring the authenticated user carries a
 * `storeId`. Must be registered AFTER `JwtGuard` so `request.user` is set.
 *
 * Bypass rule: a `SUPER_ADMIN` may pass even without a storeId — they can use
 * admin-only sub-routes; tenant-bound services that still need a storeId will
 * reject internally via the `@StoreId()` decorator.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    if (!user.storeId && user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Store context is required for this operation');
    }

    return true;
  }
}
