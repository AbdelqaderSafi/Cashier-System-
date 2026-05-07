import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';
import { ReportsService } from './reports.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';

class DailyProfitQueryDto {
  @IsOptional()
  @IsDateString()
  date?: string;
}

@ApiTags('التقارير')
@ApiBearerAuth('access-token')
@UseGuards(JwtGuard, RolesGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('daily-profit')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'تقرير الأرباح اليومية الصافية',
    description:
      'يحسب إجمالي الإيرادات والتكاليف والربح الصافي لتاريخ محدد (يُستخدم تاريخ اليوم إذا لم يُحدَّد). ' +
      'القيم مأخوذة من بنود الفواتير المخزَّنة لضمان دقة البيانات التاريخية.',
  })
  @ApiQuery({
    name: 'date',
    required: false,
    example: '2026-05-07',
    description: 'التاريخ المطلوب بصيغة YYYY-MM-DD (الافتراضي: اليوم)',
  })
  @ApiResponse({
    status: 200,
    description: 'تقرير الربح اليومي',
    schema: {
      example: {
        date: '2026-05-07',
        totalRevenue: 1500.0,
        totalCost: 900.0,
        netProfit: 600.0,
      },
    },
  })
  @ApiResponse({ status: 403, description: 'ممنوع — مطلوب دور ADMIN' })
  getDailyProfit(@CurrentUser() user: JwtPayload, @Query() query: DailyProfitQueryDto) {
    return this.reportsService.getDailyProfit(user.storeId, query.date);
  }
}
