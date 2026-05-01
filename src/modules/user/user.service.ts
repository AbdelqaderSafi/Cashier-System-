import {
  Injectable,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { User } from 'generated/prisma/client';
import type { StoreStatus } from 'generated/prisma/enums';
import { Role } from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

export type SafeUser = Omit<User, 'password'>;

export type SafeUserWithStoreSummary = SafeUser & {
  store: {
    id: string;
    name: string;
    subdomain: string | null;
    status: StoreStatus;
  } | null;
};

@Injectable()
export class UserService {
  constructor(private readonly db: DatabaseService) {}

  private stripPassword(user: User | null): SafeUser | null {
    if (!user) return null;
    const { password: _, ...rest } = user;
    return rest;
  }

  private requireStoreId(storeId: string | null): string {
    if (!storeId) {
      throw new ForbiddenException('Store context is required for this operation');
    }
    return storeId;
  }

  async findAllForSuperAdmin(storeIdFilter?: string): Promise<SafeUserWithStoreSummary[]> {
    if (storeIdFilter) {
      const storeExists = await this.db.store.findUnique({
        where: { id: storeIdFilter },
        select: { id: true },
      });
      if (!storeExists) throw new NotFoundException('Store not found');
    }

    const users = await this.db.user.findMany({
      where: storeIdFilter ? { storeId: storeIdFilter } : undefined,
      orderBy: [{ storeId: 'asc' }, { createdAt: 'asc' }],
      include: {
        store: {
          select: {
            id: true,
            name: true,
            subdomain: true,
            status: true,
          },
        },
      },
    });

    return users.map((u) => {
      const { password: _, ...rest } = u;
      return rest as SafeUserWithStoreSummary;
    });
  }

  async create(storeId: string | null, dto: CreateUserDto): Promise<SafeUser> {
    const sid = this.requireStoreId(storeId);

    const emailTaken = await this.db.user.findUnique({ where: { email: dto.email } });
    if (emailTaken) throw new ConflictException('Email is already registered');

    const usernameTaken = await this.db.user.findUnique({
      where: { username_storeId: { username: dto.username, storeId: sid } },
    });
    if (usernameTaken) throw new ConflictException('Username already taken in this store');

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const role: Role = dto.role ?? 'CASHIER';

    const user = await this.db.user.create({
      data: {
        username: dto.username,
        email: dto.email,
        password: hashedPassword,
        role,
        storeId: sid,
        isEmailVerified: true,
        emailVerificationCode: null,
      },
    });

    return this.stripPassword(user)!;
  }

  async findAll(storeId: string | null): Promise<SafeUser[]> {
    const sid = this.requireStoreId(storeId);

    const users = await this.db.user.findMany({
      where: { storeId: sid },
      orderBy: { createdAt: 'asc' },
    });

    return users.map((u) => this.stripPassword(u)!);
  }

  async findOne(storeId: string | null, id: string): Promise<SafeUser> {
    const sid = this.requireStoreId(storeId);

    const user = await this.db.user.findFirst({
      where: { id, storeId: sid },
    });

    if (!user) throw new NotFoundException('User not found');

    return this.stripPassword(user)!;
  }

  async update(storeId: string | null, id: string, dto: UpdateUserDto): Promise<SafeUser> {
    const sid = this.requireStoreId(storeId);

    await this.findOne(storeId, id);

    if (dto.email) {
      const existing = await this.db.user.findUnique({ where: { email: dto.email } });
      if (existing && existing.id !== id) {
        throw new ConflictException('Email is already registered');
      }
    }

    if (dto.username) {
      const existing = await this.db.user.findUnique({
        where: { username_storeId: { username: dto.username, storeId: sid } },
      });
      if (existing && existing.id !== id) {
        throw new ConflictException('Username already taken in this store');
      }
    }

    const updateData: {
      username?: string;
      email?: string;
      password?: string;
      role?: Role;
    } = {};

    if (dto.username !== undefined) updateData.username = dto.username;
    if (dto.email !== undefined) updateData.email = dto.email;
    if (dto.role !== undefined) updateData.role = dto.role as Role;
    if (dto.password !== undefined) {
      updateData.password = await bcrypt.hash(dto.password, 10);
    }

    if (Object.keys(updateData).length === 0) {
      return this.findOne(storeId, id);
    }

    const user = await this.db.user.update({
      where: { id },
      data: updateData,
    });

    return this.stripPassword(user)!;
  }

  async remove(storeId: string | null, id: string, currentUserId: string): Promise<void> {
    const sid = this.requireStoreId(storeId);

    if (id === currentUserId) {
      throw new BadRequestException('You cannot delete your own account');
    }

    const target = await this.db.user.findFirst({
      where: { id, storeId: sid },
    });

    if (!target) throw new NotFoundException('User not found');

    if (target.role === 'SUPER_ADMIN') {
      throw new ForbiddenException('Cannot delete a platform super admin');
    }

    await this.db.user.delete({ where: { id } });
  }
}
