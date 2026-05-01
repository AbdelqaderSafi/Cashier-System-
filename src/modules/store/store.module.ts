import { Module } from '@nestjs/common';
import { UserModule } from '../user/user.module';
import { StoreService } from './store.service';
import { StoreController } from './store.controller';
import { SuperAdminController } from './super-admin.controller';
import { SuperAdminUsersController } from './super-admin-users.controller';
import { MailModule } from '../mail/mail.module';
import { RolesGuard } from '../../common/guards/roles.guard';

@Module({
  imports: [MailModule, UserModule],
  controllers: [StoreController, SuperAdminController, SuperAdminUsersController],
  providers: [StoreService, RolesGuard],
  exports: [StoreService],
})
export class StoreModule {}
