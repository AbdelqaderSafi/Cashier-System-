import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { MailService } from '../mail/mail.service';
import { CreateStoreDTO, UpdateStoreDTO } from './dto/store.dto';

@Injectable()
export class StoreService {
  constructor(
    private readonly db: DatabaseService,
    private readonly mailService: MailService,
  ) {}

  generateSubdomain(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');
  }

  async checkSubdomainTaken(subdomain: string): Promise<void> {
    const existing = await this.db.store.findUnique({ where: { subdomain } });
    if (existing) throw new ConflictException('Store subdomain already taken');
  }

  async create(dto: CreateStoreDTO) {
    const subdomain = this.generateSubdomain(dto.name);
    await this.checkSubdomainTaken(subdomain);
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

    return { message: `Store "${updatedStore.name}" has been approved successfully.` };
  }
}
