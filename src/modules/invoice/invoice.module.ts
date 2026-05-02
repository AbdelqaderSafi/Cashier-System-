import { Module } from '@nestjs/common';
import { InvoiceService } from './invoice.service';
import { InvoiceController } from './invoice.controller';
import { RolesGuard } from '../../common/guards/roles.guard';

@Module({
  controllers: [InvoiceController],
  providers: [InvoiceService, RolesGuard],
  exports: [InvoiceService],
})
export class InvoiceModule {}
