import { Controller, Get, Patch, Body, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { StoreService } from './store.service';
import { UpdateStoreDTO } from './dto/store.dto';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';

@ApiTags('Store')
@ApiBearerAuth('access-token')
@UseGuards(JwtGuard)
@Controller('store')
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  @Get()
  @ApiOperation({ summary: 'Get current store details' })
  @ApiResponse({ status: 200, description: 'Store data' })
  getMyStore(@CurrentUser() user: JwtPayload) {
    return this.storeService.findById(user.storeId as string);
  }

  @Patch()
  @ApiOperation({ summary: 'Update current store details (Admin only)' })
  @ApiResponse({ status: 200, description: 'Store updated' })
  @ApiResponse({ status: 409, description: 'Subdomain already taken' })
  updateMyStore(@CurrentUser() user: JwtPayload, @Body() dto: UpdateStoreDTO) {
    return this.storeService.update(user.storeId as string, dto);
  }
}
