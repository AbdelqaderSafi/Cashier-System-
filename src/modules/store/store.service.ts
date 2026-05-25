import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { MailService } from '../mail/mail.service';
import { CacheInvalidationService } from '../../common/cache/cache-invalidation.service';
import { CreateStoreDTO, UpdateStoreDTO } from './dto/store.dto';

@Injectable()
export class StoreService {
  constructor(
    private readonly db: DatabaseService,
    private readonly mailService: MailService,
    private readonly cacheInvalidation: CacheInvalidationService,
  ) {}

  generateSubdomain(name: string): string {
    const latinized = name
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/^-+|-+$/g, '');

    if (latinized.length >= 3) {
      return latinized;
    }

    // Fallback for Arabic/non-Latin names: generate a unique slug
    const randomSuffix = Math.random().toString(36).slice(2, 8);
    return `store-${randomSuffix}`;
  }

  async checkSubdomainTaken(subdomain: string): Promise<void> {
    if (!subdomain || subdomain.length < 3) {
      throw new BadRequestException(
        'Could not generate a valid subdomain. Please use a store name with English letters.',
      );
    }
    const existing = await this.db.store.findUnique({ where: { subdomain } });
    if (existing) throw new ConflictException('Store subdomain already taken');
  }

  async generateUniqueSubdomain(name: string): Promise<string> {
    const latinized = name
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/^-+|-+$/g, '');

    const base = latinized.length >= 3 ? latinized : 'store';

    let subdomain = base;
    let attempt = 0;

    while (attempt < 10) {
      const existing = await this.db.store.findUnique({ where: { subdomain } });
      if (!existing) return subdomain;
      const suffix = Math.random().toString(36).slice(2, 7);
      subdomain = `${base}-${suffix}`;
      attempt++;
    }

    throw new ConflictException('Failed to generate a unique subdomain. Please try again.');
  }

  async findAll() {
    return this.db.store.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        subdomain: true,
        plan: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { users: true, products: true, customers: true } },
      },
    });
  }

  async create(dto: CreateStoreDTO) {
    const subdomain = await this.generateUniqueSubdomain(dto.name);
    return this.db.store.create({ data: { name: dto.name, subdomain } });
  }

  async findById(id: string) {
    const store = await this.db.store.findUnique({ where: { id } });
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  async findBySubdomain(subdomain: string) {
    const store = await this.db.store.findUnique({ where: { subdomain } });
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  async update(id: string, dto: UpdateStoreDTO) {
    await this.findById(id);

    if (dto.subdomain) {
      const existing = await this.db.store.findUnique({
        where: { subdomain: dto.subdomain },
      });
      if (existing && existing.id !== id)
        throw new ConflictException('Subdomain already taken');
    }

    return this.db.store.update({ where: { id }, data: dto });
  }

  async approveStore(storeId: string): Promise<{ message: string }> {
    const store = await this.findById(storeId);

    if (store.status === 'APPROVED') {
      throw new BadRequestException('Store is already approved');
    }

    const updatedStore = await this.db.store.update({
      where: { id: storeId },
      data: { status: 'APPROVED' },
    });

    const adminUser = await this.db.user.findFirst({
      where: { storeId, role: 'ADMIN' },
    });

    if (adminUser && !adminUser.isEmailVerified) {
      throw new BadRequestException(
        'Cannot approve store: the store owner has not verified their email address yet.',
      );
    }

    if (adminUser) {
      await this.mailService.sendWelcomeEmail(
        adminUser.email,
        updatedStore.name,
        updatedStore.subdomain ?? '',
        adminUser.username,
      );
    }

    // Bust the JwtGuard status cache so any pending sessions see the new state.
    await this.cacheInvalidation.invalidateStoreStatus(storeId);

    return { message: `Store "${updatedStore.name}" has been approved successfully.` };
  }

  async suspendStore(storeId: string): Promise<{ message: string }> {
    const store = await this.findById(storeId);

    if (store.status === 'SUSPENDED') {
      throw new BadRequestException('Store is already suspended');
    }

    const updated = await this.db.store.update({
      where: { id: storeId },
      data: { status: 'SUSPENDED' },
    });

    // Bust the JwtGuard status cache so open sessions are kicked out on their
    // next request instead of waiting up to STORE_STATUS TTL.
    await this.cacheInvalidation.invalidateStoreStatus(storeId);

    return { message: `Store "${updated.name}" has been suspended.` };
  }

  async reactivateStore(storeId: string): Promise<{ message: string }> {
    const store = await this.findById(storeId);

    if (store.status !== 'SUSPENDED') {
      throw new BadRequestException('Only suspended stores can be reactivated');
    }

    const updated = await this.db.store.update({
      where: { id: storeId },
      data: { status: 'APPROVED' },
    });

    await this.cacheInvalidation.invalidateStoreStatus(storeId);

    return { message: `Store "${updated.name}" has been reactivated.` };
  }
}
