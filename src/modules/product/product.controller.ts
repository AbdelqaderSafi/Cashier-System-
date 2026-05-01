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
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';

@ApiTags('المنتجات')
@ApiBearerAuth('access-token')
@UseGuards(JwtGuard, RolesGuard)
@Controller('products')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Post()
  @Roles('ADMIN')
  @ApiOperation({ summary: 'إنشاء منتج جديد في المتجر الحالي (للمدير فقط)' })
  @ApiResponse({ status: 201, description: 'تم إنشاء المنتج بنجاح' })
  @ApiResponse({ status: 409, description: 'الباركود موجود مسبقاً في هذا المتجر' })
  @ApiResponse({ status: 403, description: 'ممنوع — مطلوب دور ADMIN' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateProductDto) {
    return this.productService.create(user.storeId, dto);
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
  findAll(@CurrentUser() user: JwtPayload, @Query() query: ProductQueryDto) {
    return this.productService.findAll(user.storeId, query);
  }

  @Get('low-stock')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'المنتجات النشطة التي انخفض مخزونها عن حد التنبيه minStock (للمدير فقط)',
  })
  @ApiResponse({ status: 200, description: 'قائمة منتجات قليلة المخزون مرتبة تصاعدياً حسب الكمية' })
  findLowStock(@CurrentUser() user: JwtPayload) {
    return this.productService.findLowStock(user.storeId);
  }

  @Get('barcode/:barcode')
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({ summary: 'البحث عن منتج بالباركود (مناسب لمسح الكاشير)' })
  @ApiParam({ name: 'barcode', description: 'نص الباركود', example: '6001234567890' })
  @ApiResponse({ status: 200, description: 'تم العثور على المنتج' })
  @ApiResponse({ status: 404, description: 'لا يوجد منتج نشط بهذا الباركود' })
  findByBarcode(@CurrentUser() user: JwtPayload, @Param('barcode') barcode: string) {
    return this.productService.findByBarcode(user.storeId, barcode);
  }

  @Get(':id')
  @Roles('ADMIN', 'CASHIER')
  @ApiOperation({ summary: 'جلب منتج بالمعرّف (يشمل آخر 10 بنود فواتير)' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'معرّف المنتج' })
  @ApiResponse({ status: 200, description: 'المنتج مع سجل مبيعات حديث' })
  @ApiResponse({ status: 404, description: 'المنتج غير موجود' })
  findOne(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.productService.findOne(user.storeId, id);
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
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.productService.update(user.storeId, id, dto);
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
  async remove(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    await this.productService.remove(user.storeId, id);
  }
}
