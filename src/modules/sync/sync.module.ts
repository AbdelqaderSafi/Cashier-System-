import { Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { DatabaseModule } from '../database/database.module';
import { RolesGuard } from '../../common/guards/roles.guard';

@Module({
  imports: [DatabaseModule],
  controllers: [SyncController],
  providers: [SyncService, RolesGuard],
})
export class SyncModule {}
