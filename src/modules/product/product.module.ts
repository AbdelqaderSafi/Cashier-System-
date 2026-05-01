import { Module } from '@nestjs/common';
import { ProductService } from './product.service';
import { ProductController } from './product.controller';
import { RolesGuard } from '../../common/guards/roles.guard';

@Module({
  controllers: [ProductController],
  providers: [ProductService, RolesGuard],
  exports: [ProductService],
})
export class ProductModule {}
