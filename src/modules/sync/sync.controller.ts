import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
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
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';

@ApiTags('المزامنة (Sync)')
@ApiBearerAuth('access-token')
@UseGuards(JwtGuard, RolesGuard)
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
  getInitData(@CurrentUser() user: JwtPayload) {
    return this.syncService.getInitData(user.storeId);
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
  push(@CurrentUser() user: JwtPayload, @Body() dto: SyncPushDto) {
    return this.syncService.push(user.storeId, dto);
  }
}
