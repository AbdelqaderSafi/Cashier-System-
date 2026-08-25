import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
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
import { CustomerService } from './customer.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CustomerQueryDto } from './dto/customer-query.dto';
import { RemoveCustomerQueryDto } from './dto/remove-customer-query.dto';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { StoreId } from '../../common/decorators/store-id.decorator';

@ApiTags('العملاء')
@ApiBearerAuth('access-token')
@UseGuards(JwtGuard, TenantGuard, RolesGuard)
@Controller('customers')
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  @Post()
  @Roles('ADMIN')
  @ApiOperation({ summary: 'إنشاء عميل جديد في المتجر الحالي (للمدير فقط)' })
  @ApiResponse({ status: 201, description: 'تم إنشاء العميل بنجاح' })
  @ApiResponse({ status: 403, description: 'ممنوع — مطلوب دور ADMIN' })
  create(@StoreId() sid: string, @Body() dto: CreateCustomerDto) {
    return this.customerService.create(sid, dto);
  }

  @Get()
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({ summary: 'قائمة العملاء مع بحث اختياري وترقيم الصفحات' })
  @ApiQuery({ name: 'search', required: false, description: 'البحث بالاسم أو رقم الهاتف' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1, description: 'رقم الصفحة' })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20, description: 'عدد العناصر لكل صفحة' })
  @ApiResponse({ status: 200, description: 'قائمة عملاء مُرقّمة' })
  findAll(@StoreId() sid: string, @Query() query: CustomerQueryDto) {
    return this.customerService.findAll(sid, query);
  }

  @Get(':id')
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({ summary: 'جلب عميل بالمعرّف (يشمل آخر 20 فاتورة وكافة الديون مع سجل الدفعات)' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'معرّف العميل' })
  @ApiResponse({
    status: 200,
    description:
      'العميل مع فواتيره وديونه، و customerPayments: آخر 50 عملية قبض على حساب ' +
      'العميل (مع customerPaymentsTotal = العدد الكلي). ' +
      'تنبيه: هاد السجل يغطي POST /debts/customer/:customerId/pay فقط — ' +
      'الدفع على دين مفرد و sync/push يقبضان نقداً ولا يظهران فيه.',
  })
  @ApiResponse({ status: 404, description: 'العميل غير موجود' })
  findOne(@StoreId() sid: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.customerService.findOne(sid, id);
  }

  @Get(':id/debt-summary')
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({ summary: 'ملخص ديون العميل — الإجماليات + تفاصيل كل دين' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'معرّف العميل' })
  @ApiResponse({ status: 200, description: 'ملخص ديون العميل' })
  @ApiResponse({ status: 404, description: 'العميل غير موجود' })
  getDebtSummary(@StoreId() sid: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.customerService.getDebtSummary(sid, id);
  }

  @Patch(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'تحديث بيانات العميل (للمدير فقط)' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'معرّف العميل' })
  @ApiResponse({ status: 200, description: 'تم تحديث العميل' })
  @ApiResponse({ status: 404, description: 'العميل غير موجود' })
  update(
    @StoreId() sid: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customerService.update(sid, id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'حذف عميل نهائياً (للمدير فقط). يُمنع الحذف إذا كان لديه ديون غير مسددة أو رصيد لم يُستخدم — إلا بإرسال forfeitCredit=true لإسقاط الرصيد وأرشفته.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'معرّف العميل' })
  @ApiQuery({
    name: 'forfeitCredit',
    required: false,
    type: Boolean,
    description:
      'إسقاط رصيد العميل نهائياً وأرشفته رغم وجود رصيد لم يُستخدم (للمدير فقط)',
  })
  @ApiResponse({ status: 204, description: 'تم حذف العميل' })
  @ApiResponse({
    status: 400,
    description: 'لا يمكن الحذف — يوجد ديون غير مسددة أو رصيد لم يُستخدم',
  })
  @ApiResponse({ status: 404, description: 'العميل غير موجود' })
  async remove(
    @StoreId() sid: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: RemoveCustomerQueryDto,
  ) {
    await this.customerService.remove(sid, id, query.forfeitCredit ?? false);
  }
}
