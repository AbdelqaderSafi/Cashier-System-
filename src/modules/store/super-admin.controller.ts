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

@ApiTags('Super Admin')
@ApiBearerAuth('access-token')
@UseGuards(JwtGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('admin/stores')
export class SuperAdminController {
  constructor(private readonly storeService: StoreService) {}

  @Patch(':storeId/approve')
  @ApiOperation({ summary: 'Approve a pending store (Super Admin only)' })
  @ApiParam({ name: 'storeId', description: 'UUID of the store to approve' })
  @ApiResponse({ status: 200, description: 'Store approved and welcome email sent to owner' })
  @ApiResponse({ status: 400, description: 'Store is already approved or email not verified' })
  @ApiResponse({ status: 403, description: 'Forbidden — SUPER_ADMIN role required' })
  @ApiResponse({ status: 404, description: 'Store not found' })
  approveStore(@Param('storeId') storeId: string) {
    return this.storeService.approveStore(storeId);
  }
}
