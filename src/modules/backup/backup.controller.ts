import { Controller, Post, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { BackupService } from './backup.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';

@ApiTags('النسخ الاحتياطي')
@ApiBearerAuth('access-token')
@UseGuards(JwtGuard, RolesGuard)
@Controller('backup')
export class BackupController {
  constructor(private readonly backupService: BackupService) {}

  /**
   * SUPER_ADMIN only — triggers backup for ALL approved stores at once.
   */
  @Post('trigger')
  @Roles('SUPER_ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'تشغيل النسخ الاحتياطي لكل المتاجر (SUPER_ADMIN فقط)' })
  @ApiResponse({ status: 200, description: 'تم إطلاق النسخ الاحتياطي لجميع المتاجر' })
  async triggerAll() {
    await this.backupService.handleDailyDebtBackup();
    return { message: 'تم إرسال النسخ الاحتياطي لجميع المتاجر النشطة بنجاح' };
  }

  /**
   * ADMIN only — triggers backup only for the caller's own store.
   */
  @Post('trigger-my-store')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'إرسال نسخة احتياطية لمتجري الآن (ADMIN فقط)' })
  @ApiResponse({ status: 200, description: 'تم إرسال النسخة الاحتياطية بنجاح' })
  @ApiResponse({ status: 200, description: 'لا توجد ديون حالياً' })
  async triggerMyStore(@CurrentUser() user: JwtPayload) {
    const result = await this.backupService.triggerForStore(
      user.storeId as string,
    );
    return result;
  }
}
