import { Module } from '@nestjs/common';
import { StoreService } from './store.service';
import { StoreController } from './store.controller';
import { SuperAdminController } from './super-admin.controller';
import { MailModule } from '../mail/mail.module';
import { RolesGuard } from '../../common/guards/roles.guard';

@Module({
  imports: [MailModule],
  controllers: [StoreController, SuperAdminController],
  providers: [StoreService, RolesGuard],
  exports: [StoreService],
})
export class StoreModule {}
