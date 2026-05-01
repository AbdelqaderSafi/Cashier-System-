import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseUUIDPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';

@ApiTags('المستخدمون')
@ApiBearerAuth('access-token')
@UseGuards(JwtGuard, RolesGuard)
@Roles('ADMIN')
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post()
  @ApiOperation({ summary: 'إنشاء مستخدم موظف (مدير / كاشير) في المتجر الحالي' })
  @ApiResponse({ status: 201, description: 'تم إنشاء المستخدم' })
  @ApiResponse({ status: 403, description: 'سياق المتجر مفقود أو ليس لديك الصلاحية' })
  @ApiResponse({ status: 409, description: 'البريد أو اسم المستخدم مستخدم مسبقاً' })
  create(@CurrentUser() user: JwtPayload, @Body() createUserDto: CreateUserDto) {
    return this.userService.create(user.storeId, createUserDto);
  }

  @Get()
  @ApiOperation({ summary: 'قائمة جميع المستخدمين في المتجر الحالي' })
  @ApiResponse({ status: 200, description: 'قائمة المستخدمين (بدون كلمات المرور)' })
  findAll(@CurrentUser() user: JwtPayload) {
    return this.userService.findAll(user.storeId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'جلب مستخدم واحد بالمعرّف ضمن المتجر الحالي' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'معرّف المستخدم' })
  @ApiResponse({ status: 200, description: 'بيانات المستخدم' })
  @ApiResponse({ status: 404, description: 'المستخدم غير موجود' })
  findOne(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.userService.findOne(user.storeId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'تحديث مستخدم في المتجر الحالي' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'معرّف المستخدم' })
  @ApiResponse({ status: 200, description: 'تم تحديث المستخدم' })
  @ApiResponse({ status: 404, description: 'المستخدم غير موجود' })
  @ApiResponse({ status: 409, description: 'تعارض في البريد أو اسم المستخدم' })
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    return this.userService.update(user.storeId, id, updateUserDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'حذف مستخدم من المتجر الحالي' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'معرّف المستخدم' })
  @ApiResponse({ status: 204, description: 'تم حذف المستخدم' })
  @ApiResponse({ status: 400, description: 'لا يمكن حذف حسابك أنت' })
  @ApiResponse({ status: 404, description: 'المستخدم غير موجود' })
  async remove(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    await this.userService.remove(user.storeId, id, user.sub);
  }
}
