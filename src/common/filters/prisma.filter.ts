import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { Prisma } from 'generated/prisma/client';

type ErrorBody = {
  statusCode: number;
  message: string;
  error: string;
  code?: string;
  target?: string;
};

@Catch(
  Prisma.PrismaClientKnownRequestError,
  Prisma.PrismaClientValidationError,
  Prisma.PrismaClientUnknownRequestError,
  Prisma.PrismaClientInitializationError,
  Prisma.PrismaClientRustPanicError,
)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(
    exception:
      | Prisma.PrismaClientKnownRequestError
      | Prisma.PrismaClientValidationError
      | Prisma.PrismaClientUnknownRequestError
      | Prisma.PrismaClientInitializationError
      | Prisma.PrismaClientRustPanicError,
    host: ArgumentsHost,
  ): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const body = this.toErrorBody(exception);

    if (body.statusCode >= 500) {
      this.logger.error(
        `Unhandled Prisma error: ${exception.message}`,
        exception.stack,
      );
    }

    response.status(body.statusCode).json(body);
  }

  private toErrorBody(exception: unknown): ErrorBody {
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.mapKnownRequestError(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'بيانات الطلب غير صالحة',
        error: 'Bad Request',
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'حدث خطأ غير متوقع. يرجى المحاولة لاحقاً.',
      error: 'Internal Server Error',
    };
  }

  private mapKnownRequestError(
    exception: Prisma.PrismaClientKnownRequestError,
  ): ErrorBody {
    const target = this.extractTarget(exception.meta);

    switch (exception.code) {
      case 'P2002':
        return {
          statusCode: HttpStatus.CONFLICT,
          message: target
            ? `سجل مكرر: القيمة موجودة مسبقاً (${target})`
            : 'سجل مكرر: هذه القيمة موجودة مسبقاً',
          error: 'Conflict',
          code: exception.code,
          target,
        };

      case 'P2025':
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'السجل غير موجود',
          error: 'Not Found',
          code: exception.code,
        };

      case 'P2003':
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'مرجع غير صالح: السجل المرتبط غير موجود',
          error: 'Bad Request',
          code: exception.code,
          target,
        };

      case 'P2000':
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'القيمة المُدخلة طويلة جداً لهذا الحقل',
          error: 'Bad Request',
          code: exception.code,
        };

      case 'P2014':
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'العملية تنتهك علاقة مطلوبة بين السجلات',
          error: 'Bad Request',
          code: exception.code,
        };

      default:
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'حدث خطأ في قاعدة البيانات. يرجى المحاولة لاحقاً.',
          error: 'Internal Server Error',
          code: exception.code,
        };
    }
  }

  private extractTarget(meta: Record<string, unknown> | undefined): string | undefined {
    if (!meta) return undefined;

    const target = meta.target;
    if (Array.isArray(target)) return target.join(', ');
    if (typeof target === 'string') return target;

    const field = meta.field_name ?? meta.constraint;
    if (typeof field === 'string') return field;

    return undefined;
  }
}
