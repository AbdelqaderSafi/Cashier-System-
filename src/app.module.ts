import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './modules/database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { StoreModule } from './modules/store/store.module';
import { UserModule } from './modules/user/user.module';
import { ProductModule } from './modules/product/product.module';
import { CustomerModule } from './modules/customer/customer.module';
import { InvoiceModule } from './modules/invoice/invoice.module';
import { DebtModule } from './modules/debt/debt.module';
import { BackupModule } from './modules/backup/backup.module';
import { SyncModule } from './modules/sync/sync.module';
import { ReportsModule } from './modules/reports/reports.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DatabaseModule,
    AuthModule,
    StoreModule,
    UserModule,
    ProductModule,
    CustomerModule,
    InvoiceModule,
    DebtModule,
    BackupModule,
    SyncModule,
    ReportsModule,
  ],
})
export class AppModule {}
