import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserService } from '../user/user.service';
import { SuperAdminListUsersQueryDto } from '../user/dto/super-admin-list-users-query.dto';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('المشرف العام')
@ApiBearerAuth('access-token')
@UseGuards(JwtGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('admin/users')
export class SuperAdminUsersController {
  constructor(private readonly userService: UserService) {}

  @Get()
  @ApiOperation({
    summary: 'قائمة جميع المستخدمين في النظام (مع إمكانية التصفية حسب المتجر)',
    description:
      'تُعاد كل المستخدمين عبر كل المستأجرين. مرّر storeId كمعامل استعلام لتحديد متجر واحد. كل صف يتضمن كائن store (أو null لحسابات SUPER_ADMIN على المنصة).',
  })
  @ApiQuery({
    name: 'storeId',
    required: false,
    type: String,
    format: 'uuid',
    description: 'اختياري — تصفية المستخدمين التابعين لهذا المتجر فقط',
  })
  @ApiResponse({ status: 200, description: 'قائمة المستخدمين (كلمات المرور لا تُعاد أبداً)' })
  @ApiResponse({ status: 403, description: 'ممنوع — مطلوب دور SUPER_ADMIN' })
  @ApiResponse({ status: 404, description: 'المتجر غير موجود (عند تمرير storeId)' })
  listAllUsers(@Query() query: SuperAdminListUsersQueryDto) {
    return this.userService.findAllForSuperAdmin(query.storeId);
  }
}
