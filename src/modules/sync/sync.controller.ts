import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SyncService } from './sync.service';
import { SyncPushDto } from './dto/sync-push.dto';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { StoreId } from '../../common/decorators/store-id.decorator';

@ApiTags('المزامنة (Sync)')
@ApiBearerAuth('access-token')
@UseGuards(JwtGuard, TenantGuard, RolesGuard)
@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  // ─── GET /sync/init ───────────────────────────────────────────────────────────
  @Get('init')
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({
    summary: 'بيانات التهيئة الأولية للـ PWA',
    description:
      'يُستدعى عند تحميل التطبيق أونلاين. يُعيد المنتجات النشطة والعملاء والديون غير المسدَّدة ' +
      'لتعبئة قاعدة بيانات IndexedDB المحلية.',
  })
  @ApiResponse({
    status: 200,
    description: 'بيانات التهيئة: منتجات، عملاء، ديون مفتوحة',
    schema: {
      example: {
        products: [],
        customers: [],
        debts: [],
      },
    },
  })
  getInitData(
    @StoreId() sid: string,
    @Query('force-fresh') forceFresh?: string,
  ) {
    return this.syncService.getInitData(sid, {
      forceFresh: forceFresh === 'true' || forceFresh === '1',
    });
  }

  // ─── POST /sync/push ──────────────────────────────────────────────────────────
  @Post('push')
  @Roles('ADMIN', 'CASHIER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'رفع البيانات المُنشأة أوف‌لاين إلى الخادم',
    description:
      'يستقبل دفعة من الفواتير (مع بنودها) والديون ودفعات الديون المُنشأة أثناء انقطاع الاتصال. ' +
      'العملية ذرية: أي فشل يُلغي الدفعة بالكامل. ' +
      'البيانات المكررة (من إعادة المحاولة) تُتجاهل تلقائياً بفضل UUID الفريد لكل سجل.',
  })
  @ApiResponse({
    status: 200,
    description: 'تقرير المزامنة: عدد السجلات المُدرجة والمتجاهلة لكل نوع',
    schema: {
      example: {
        message: 'تمت مزامنة البيانات بنجاح',
        report: {
          invoices: { inserted: 3, skipped: 0 },
          debts: { inserted: 1, skipped: 0 },
          debtPayments: { inserted: 2, skipped: 1 },
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'بيانات غير صالحة أو مرجع دين غير موجود' })
  push(@StoreId() sid: string, @Body() dto: SyncPushDto) {
    return this.syncService.push(sid, dto);
  }
}
