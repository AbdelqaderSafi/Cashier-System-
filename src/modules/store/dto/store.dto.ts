import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Store } from 'generated/prisma/client';

export class CreateStoreDTO {
  @ApiProperty({ example: 'Ibrahim Market' })
  name!: string;
}

export class UpdateStoreDTO extends PartialType(CreateStoreDTO) {
  @ApiPropertyOptional({ example: 'ibrahim-market' })
  subdomain?: string;
}

export type StoreResponseDTO = Omit<Store, 'store'>;
