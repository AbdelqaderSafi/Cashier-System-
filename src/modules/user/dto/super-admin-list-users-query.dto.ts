import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class SuperAdminListUsersQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'عند التحديد: إرجاع مستخدمي هذا المتجر فقط. عند الإهمال: جميع المستخدمين في النظام.',
  })
  @IsOptional()
  @IsUUID('4')
  storeId?: string;
}
