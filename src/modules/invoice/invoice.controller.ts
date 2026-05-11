import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Delete,
  Query,
  ParseUUIDPipe,
  ParseIntPipe,
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
import { InvoiceService } from './invoice.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';
import { InvoiceQueryDto } from './dto/invoice-query.dto';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';

@ApiTags('الفواتير')
@ApiBearerAuth('access-token')
@UseGuards(JwtGuard, RolesGuard)
@Controller('invoices')
export class InvoiceController {
  constructor(private readonly invoiceService: InvoiceService) {}

  @Post()
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({
    summary: 'إنشاء فاتورة جديدة — يخصم المخزون ويُنشئ سجل دين تلقائياً عند الآجل/الجزئي',
  })
  @ApiResponse({ status: 201, description: 'تم إنشاء الفاتورة بنجاح' })
  @ApiResponse({ status: 400, description: 'بيانات غير صالحة أو مخزون غير كافٍ' })
  @ApiResponse({ status: 404, description: 'منتج أو عميل غير موجود' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateInvoiceDto) {
    return this.invoiceService.create(user.storeId, dto);
  }

  @Get()
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({ summary: 'قائمة الفواتير مع بحث وتصفية وترقيم الصفحات' })
  @ApiQuery({ name: 'search', required: false, description: 'البحث برقم الفاتورة أو اسم العميل' })
  @ApiQuery({ name: 'paymentMethod', required: false, enum: ['CASH', 'ONLINE', 'DEBT', 'PARTIAL'], description: 'تصفية حسب طريقة الدفع' })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'تاريخ البداية (YYYY-MM-DD)' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'تاريخ النهاية (YYYY-MM-DD)' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1, description: 'رقم الصفحة' })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20, description: 'عدد العناصر لكل صفحة' })
  @ApiResponse({ status: 200, description: 'قائمة فواتير مُرقّمة' })
  findAll(@CurrentUser() user: JwtPayload, @Query() query: InvoiceQueryDto) {
    return this.invoiceService.findAll(user.storeId, query);
  }

  @Get('daily-sales')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'ملخص المبيعات اليومية — الإجماليات حسب طريقة الدفع' })
  @ApiQuery({ name: 'date', required: false, description: 'التاريخ (YYYY-MM-DD)، افتراضياً اليوم' })
  @ApiResponse({ status: 200, description: 'ملخص المبيعات اليومية' })
  getDailySales(@CurrentUser() user: JwtPayload, @Query('date') date?: string) {
    return this.invoiceService.getDailySales(user.storeId, date);
  }

  @Get('number/:number')
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({ summary: 'جلب فاتورة برقمها التسلسلي' })
  @ApiParam({ name: 'number', type: Number, description: 'رقم الفاتورة التسلسلي' })
  @ApiResponse({ status: 200, description: 'الفاتورة مع بنودها وبيانات العميل والدين' })
  @ApiResponse({ status: 404, description: 'الفاتورة غير موجودة' })
  findByNumber(
    @CurrentUser() user: JwtPayload,
    @Param('number', ParseIntPipe) invoiceNumber: number,
  ) {
    return this.invoiceService.findByNumber(user.storeId, invoiceNumber);
  }

  @Get(':id')
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({ summary: 'جلب فاتورة بالمعرّف — يشمل البنود والعميل وسجل الدين' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'معرّف الفاتورة' })
  @ApiResponse({ status: 200, description: 'الفاتورة مع كافة التفاصيل' })
  @ApiResponse({ status: 404, description: 'الفاتورة غير موجودة' })
  findOne(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoiceService.findOne(user.storeId, id);
  }

  @Patch(':id')
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({
    summary:
      'تعديل فاتورة — يُعيد ضبط المخزون تلقائياً ويدعم استبدال المنتجات وتغيير طريقة الدفع',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'معرّف الفاتورة' })
  @ApiResponse({ status: 200, description: 'تم تحديث الفاتورة بنجاح' })
  @ApiResponse({ status: 400, description: 'بيانات غير صالحة أو مخزون غير كافٍ أو دين عليه دفعات' })
  @ApiResponse({ status: 404, description: 'الفاتورة أو المنتج أو العميل غير موجود' })
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInvoiceDto,
  ) {
    return this.invoiceService.update(user.storeId, id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'حذف فاتورة نهائياً (للمدير فقط) — يُعيد المخزون ويحذف الدين المرتبط',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'معرّف الفاتورة' })
  @ApiResponse({ status: 204, description: 'تم حذف الفاتورة' })
  @ApiResponse({ status: 400, description: 'لا يمكن الحذف — يوجد دفعات على الدين المرتبط' })
  @ApiResponse({ status: 404, description: 'الفاتورة غير موجودة' })
  async remove(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    await this.invoiceService.remove(user.storeId, id);
  }
}
