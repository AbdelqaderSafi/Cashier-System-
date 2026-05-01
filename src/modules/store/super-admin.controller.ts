import { Controller, Patch, Param, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { StoreService } from './store.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('المشرف العام')
@ApiBearerAuth('access-token')
@UseGuards(JwtGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('admin/stores')
export class SuperAdminController {
  constructor(private readonly storeService: StoreService) {}

  @Patch(':storeId/approve')
  @ApiOperation({ summary: 'الموافقة على متجر قيد الانتظار (للمشرف العام فقط)' })
  @ApiParam({ name: 'storeId', description: 'معرّف المتجر (UUID)' })
  @ApiResponse({ status: 200, description: 'تمت الموافقة على المتجر وإرسال بريد ترحيب لمالكه' })
  @ApiResponse({ status: 400, description: 'المتجر مُوافَق عليه مسبقاً أو البريد غير مُؤكَّد' })
  @ApiResponse({ status: 403, description: 'ممنوع — مطلوب دور SUPER_ADMIN' })
  @ApiResponse({ status: 404, description: 'المتجر غير موجود' })
  approveStore(@Param('storeId') storeId: string) {
    return this.storeService.approveStore(storeId);
  }
}
