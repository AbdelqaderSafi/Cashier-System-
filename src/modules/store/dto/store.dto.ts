import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Store } from 'generated/prisma/client';

export class CreateStoreDTO {
  @ApiProperty({ example: 'Ibrahim Market', description: 'اسم المتجر' })
  name!: string;
}

export class UpdateStoreDTO extends PartialType(CreateStoreDTO) {
  @ApiPropertyOptional({ example: 'ibrahim-market', description: 'النطاق الفرعي للمتجر (slug)' })
  subdomain?: string;
}

export type StoreResponseDTO = Omit<Store, 'store'>;
