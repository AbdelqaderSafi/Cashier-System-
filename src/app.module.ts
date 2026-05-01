import { Module } from '@nestjs/common';
import { DatabaseModule } from './modules/database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { StoreModule } from './modules/store/store.module';

@Module({
  imports: [DatabaseModule, AuthModule, StoreModule],
})
export class AppModule {}
