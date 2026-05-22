import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { DatabaseService } from '../database/database.service';

@ApiTags('Health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaIndicator: PrismaHealthIndicator,
    private readonly db: DatabaseService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @HealthCheck()
  @ApiOperation({
    summary: 'Liveness + readiness probe (verifies the database is reachable)',
  })
  @ApiResponse({ status: 200, description: 'Service is healthy' })
  @ApiResponse({ status: 503, description: 'Service is unhealthy — at least one dependency is down' })
  check() {
    return this.health.check([
      () => this.prismaIndicator.pingCheck('database', this.db, { timeout: 3_000 }),
    ]);
  }
}
