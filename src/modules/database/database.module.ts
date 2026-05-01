import { Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { Global } from '@nestjs/common';
@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
