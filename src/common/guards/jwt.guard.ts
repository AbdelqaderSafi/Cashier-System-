import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Request } from 'express';
import { env } from '../config/env';
import { DatabaseService } from '../../modules/database/database.service';
import { CacheKeys, CacheTtl } from '../cache/cache-keys';
import { JwtPayload } from '../decorators/current-user.decorator';

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly db: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);

    if (!token) throw new UnauthorizedException('No token provided');

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        secret: env.JWT_SECRET,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Tenant-scoped sessions must be re-checked against the live store status
    // so a SUPER_ADMIN can kick out an open session by suspending the store.
    // SUPER_ADMIN tokens carry storeId=null and are exempt.
    if (payload.storeId) {
      const status = await this.getStoreStatus(payload.storeId);
      if (status === null) {
        throw new UnauthorizedException('Store no longer exists');
      }
      if (status !== 'APPROVED') {
        throw new UnauthorizedException('Store access has been revoked');
      }
    }

    request['user'] = payload;
    return true;
  }

  private async getStoreStatus(storeId: string): Promise<string | null> {
    const key = CacheKeys.storeStatus(storeId);
    const cached = await this.cache.get<string>(key);
    if (cached !== undefined && cached !== null) return cached;

    const store = await this.db.store.findUnique({
      where: { id: storeId },
      select: { status: true },
    });
    const status = store?.status ?? null;
    if (status !== null) {
      await this.cache.set(key, status, CacheTtl.STORE_STATUS);
    }
    return status;
  }

  private extractToken(request: Request): string | null {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : null;
  }
}
