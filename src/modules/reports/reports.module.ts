import { Module } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { RolesGuard } from '../../common/guards/roles.guard';

@Module({
  controllers: [ReportsController],
  providers: [ReportsService, RolesGuard],
})
export class ReportsModule {}
