import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { DebtService } from './debt.service';
import { PayDebtDto } from './dto/pay-debt.dto';
import { DebtQueryDto } from './dto/debt-query.dto';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { StoreId } from '../../common/decorators/store-id.decorator';

@ApiTags('الديون')
@ApiBearerAuth('access-token')
@UseGuards(JwtGuard, TenantGuard, RolesGuard)
@Controller('debts')
export class DebtController {
  constructor(private readonly debtService: DebtService) {}

  // ─── GET /debts ───────────────────────────────────────────────────────────────

  @Get()
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({ summary: 'قائمة الديون مع تصفية وترقيم الصفحات' })
  @ApiQuery({ name: 'search', required: false, description: 'البحث باسم العميل' })
  @ApiQuery({ name: 'customerId', required: false, description: 'تصفية بمعرّف العميل (UUID)' })
  @ApiQuery({ name: 'isPaid', required: false, type: Boolean, description: 'true = مسددة | false = غير مسددة' })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'تاريخ البداية (YYYY-MM-DD)' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'تاريخ النهاية (YYYY-MM-DD)' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({ status: 200, description: 'قائمة ديون مُرقّمة' })
  findAll(@StoreId() sid: string, @Query() query: DebtQueryDto) {
    return this.debtService.findAll(sid, query);
  }

  // ─── GET /debts/summary ───────────────────────────────────────────────────────

  @Get('summary')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'ملخص إجمالي الديون للمتجر — المجموع الكلي والمتبقي وعدد غير المسددة' })
  @ApiResponse({ status: 200, description: 'ملخص الديون' })
  getSummary(@StoreId() sid: string) {
    return this.debtService.getSummary(sid);
  }

  // ─── GET /debts/customer/:customerId ─────────────────────────────────────────

  @Get('customer/:customerId')
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({ summary: 'جميع ديون عميل محدد مع ملخص' })
  @ApiParam({ name: 'customerId', format: 'uuid', description: 'معرّف العميل' })
  @ApiResponse({ status: 200, description: 'ديون العميل مع الملخص' })
  @ApiResponse({ status: 404, description: 'العميل غير موجود' })
  findByCustomer(
    @StoreId() sid: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.debtService.findByCustomer(sid, customerId);
  }

  // ─── POST /debts/customer/:customerId/pay ─────────────────────────────────────

  @Post('customer/:customerId/pay')
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({
    summary:
      'تسديد مبلغ من الدين الكلي للعميل — يوزّع المبلغ تلقائياً على الديون من الأقدم للأحدث',
  })
  @ApiParam({ name: 'customerId', format: 'uuid', description: 'معرّف العميل' })
  @ApiResponse({
    status: 201,
    description: 'تم تسجيل الدفعة وتوزيعها — يعيد ملخص الديون المحدّث',
  })
  @ApiResponse({ status: 400, description: 'لا توجد ديون أو المبلغ يتجاوز الإجمالي' })
  @ApiResponse({ status: 404, description: 'العميل غير موجود' })
  payForCustomer(
    @StoreId() sid: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: PayDebtDto,
  ) {
    return this.debtService.payForCustomer(sid, customerId, dto);
  }

  // ─── GET /debts/:id ───────────────────────────────────────────────────────────

  @Get(':id')
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({ summary: 'جلب دين بالمعرّف — يشمل بيانات العميل والفاتورة وكل الدفعات' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'معرّف الدين' })
  @ApiResponse({ status: 200, description: 'تفاصيل الدين الكاملة' })
  @ApiResponse({ status: 404, description: 'الدين غير موجود' })
  findOne(@StoreId() sid: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.debtService.findOne(sid, id);
  }

  // ─── POST /debts/:id/pay ──────────────────────────────────────────────────────

  @Post(':id/pay')
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({
    summary: 'تسجيل دفعة على دين — يُحدّث المبلغ المدفوع والمتبقي في الدين والفاتورة تلقائياً',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'معرّف الدين' })
  @ApiResponse({ status: 201, description: 'تم تسجيل الدفعة بنجاح' })
  @ApiResponse({ status: 400, description: 'الدين مسدد بالفعل أو المبلغ يتجاوز المتبقي' })
  @ApiResponse({ status: 404, description: 'الدين غير موجود' })
  pay(
    @StoreId() sid: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayDebtDto,
  ) {
    return this.debtService.pay(sid, id, dto);
  }

  // ─── GET /debts/:id/payments ──────────────────────────────────────────────────

  @Get(':id/payments')
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({ summary: 'قائمة جميع الدفعات لدين محدد' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'معرّف الدين' })
  @ApiResponse({ status: 200, description: 'دفعات الدين' })
  @ApiResponse({ status: 404, description: 'الدين غير موجود' })
  getPayments(@StoreId() sid: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.debtService.getPayments(sid, id);
  }

  // ─── DELETE /debts/:id/payments/:paymentId ────────────────────────────────────

  @Delete(':id/payments/:paymentId')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'حذف دفعة (للمدير فقط) — يعكس المبلغ ويُحدّث الدين والفاتورة تلقائياً',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'معرّف الدين' })
  @ApiParam({ name: 'paymentId', format: 'uuid', description: 'معرّف الدفعة' })
  @ApiResponse({ status: 204, description: 'تم حذف الدفعة' })
  @ApiResponse({ status: 404, description: 'الدين أو الدفعة غير موجودة' })
  async deletePayment(
    @StoreId() sid: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ) {
    await this.debtService.deletePayment(sid, id, paymentId);
  }
}
