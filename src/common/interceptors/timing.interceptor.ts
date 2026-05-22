import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

@Injectable()
export class TimingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const { method } = req;
    const path = (req.route?.path as string | undefined) ?? req.originalUrl?.split('?')[0] ?? req.url;

    const now = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const delay = Date.now() - now;
          this.logger.log(`${method} ${path} - ${delay}ms`);
        },
        error: (err) => {
          const delay = Date.now() - now;
          const status = err?.status ?? 500;
          this.logger.warn(`${method} ${path} - ${status} - ${delay}ms`);
        },
      }),
    );
  }
}
