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
import { ProductService } from './product.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductQueryDto } from './dto/product-query.dto';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { StoreId } from '../../common/decorators/store-id.decorator';

@ApiTags('المنتجات')
@ApiBearerAuth('access-token')
@UseGuards(JwtGuard, TenantGuard, RolesGuard)
@Controller('products')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Post()
  @Roles('ADMIN')
  @ApiOperation({ summary: 'إنشاء منتج جديد في المتجر الحالي (للمدير فقط)' })
  @ApiResponse({ status: 201, description: 'تم إنشاء المنتج بنجاح' })
  @ApiResponse({ status: 409, description: 'الباركود موجود مسبقاً في هذا المتجر' })
  @ApiResponse({ status: 403, description: 'ممنوع — مطلوب دور ADMIN' })
  create(@StoreId() sid: string, @Body() dto: CreateProductDto) {
    return this.productService.create(sid, dto);
  }

  @Get()
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({
    summary: 'قائمة المنتجات مع بحث اختياري، تصفية الحالة، وترقيم الصفحات',
  })
  @ApiQuery({ name: 'search', required: false, description: 'البحث بالاسم أو الباركود' })
  @ApiQuery({
    name: 'isActive',
    required: false,
    type: Boolean,
    description: 'تصفية حسب نشاط المنتج',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1, description: 'رقم الصفحة' })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20, description: 'عدد العناصر لكل صفحة' })
  @ApiResponse({ status: 200, description: 'قائمة منتجات مُرقّمة' })
  findAll(@StoreId() sid: string, @Query() query: ProductQueryDto) {
    return this.productService.findAll(sid, query);
  }

  @Get('low-stock')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'المنتجات النشطة التي انخفض مخزونها عن حد التنبيه minStock (للمدير فقط)',
  })
  @ApiResponse({ status: 200, description: 'قائمة منتجات قليلة المخزون مرتبة تصاعدياً حسب الكمية' })
  findLowStock(@StoreId() sid: string) {
    return this.productService.findLowStock(sid);
  }

  @Get('barcode/:barcode')
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({ summary: 'البحث عن منتج بالباركود (مناسب لمسح الكاشير)' })
  @ApiParam({ name: 'barcode', description: 'نص الباركود', example: '6001234567890' })
  @ApiResponse({ status: 200, description: 'تم العثور على المنتج' })
  @ApiResponse({ status: 404, description: 'لا يوجد منتج نشط بهذا الباركود' })
  findByBarcode(@StoreId() sid: string, @Param('barcode') barcode: string) {
    return this.productService.findByBarcode(sid, barcode);
  }

  @Get(':id')
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({ summary: 'جلب منتج بالمعرّف (يشمل آخر 10 بنود فواتير)' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'معرّف المنتج' })
  @ApiResponse({ status: 200, description: 'المنتج مع سجل مبيعات حديث' })
  @ApiResponse({ status: 404, description: 'المنتج غير موجود' })
  findOne(@StoreId() sid: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.productService.findOne(sid, id);
  }

  @Patch(':id')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'تحديث منتج (للمدير فقط) — استخدم isActive: false للتعطيل',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'معرّف المنتج' })
  @ApiResponse({ status: 200, description: 'تم تحديث المنتج' })
  @ApiResponse({ status: 404, description: 'المنتج غير موجود' })
  @ApiResponse({ status: 409, description: 'الباركود مُستخدم لمنتج آخر' })
  update(
    @StoreId() sid: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.productService.update(sid, id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'حذف منتج نهائياً (للمدير فقط). بنود الفواتير تُحفظ — يُعيّن productId إلى null.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'معرّف المنتج' })
  @ApiResponse({ status: 204, description: 'تم حذف المنتج' })
  @ApiResponse({ status: 404, description: 'المنتج غير موجود' })
  async remove(@StoreId() sid: string, @Param('id', ParseUUIDPipe) id: string) {
    await this.productService.remove(sid, id);
  }
}
