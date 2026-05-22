import { Global, Module } from '@nestjs/common';
import { CacheInvalidationService } from './cache-invalidation.service';

@Global()
@Module({
  providers: [CacheInvalidationService],
  exports: [CacheInvalidationService],
})
export class AppCacheModule {}
