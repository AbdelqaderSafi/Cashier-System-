import { Injectable, Logger } from '@nestjs/common';

interface BrevoAttachment {
  name: string;
  content: string;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly apiKey = process.env.BREVO_API_KEY ?? '';
  private readonly apiUrl = 'https://api.brevo.com/v3/smtp/email';
  private readonly sender = { email: 'saabood519@gmail.com', name: 'Safi POS' };

  private async send(payload: object): Promise<void> {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'api-key': this.apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Brevo API error ${response.status}: ${body}`);
    }
  }

  async sendEmailVerificationOtp(email: string, username: string, otp: string) {
    try {
      await this.send({
        sender: this.sender,
        to: [{ email }],
        subject: 'رمز التحقق الخاص بك - Safi POS',
        htmlContent: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
            <div style="background: #4F46E5; padding: 32px 24px; border-radius: 8px 8px 0 0; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 24px;">تحقق من بريدك الإلكتروني</h1>
            </div>
            <div style="background: #ffffff; padding: 32px 24px; border: 1px solid #E5E7EB; border-top: none;">
              <p style="font-size: 16px;">مرحباً <b>${username}</b>،</p>
              <p style="font-size: 16px;">
                شكراً لتسجيلك في Safi POS! استخدم الرمز أدناه للتحقق من بريدك الإلكتروني.
                هذا الرمز صالح لمدة <b>15 دقيقة</b>.
              </p>
              <div style="text-align: center; margin: 32px 0;">
                <div style="display: inline-block; background: #F3F4F6; border: 2px dashed #4F46E5;
                            border-radius: 12px; padding: 20px 40px;">
                  <p style="margin: 0; font-size: 13px; color: #6B7280; letter-spacing: 1px;">
                    رمز التحقق الخاص بك
                  </p>
                  <p style="margin: 8px 0 0 0; font-size: 42px; font-weight: bold;
                            letter-spacing: 12px; color: #4F46E5;">
                    ${otp}
                  </p>
                </div>
              </div>
              <p style="font-size: 14px; color: #6B7280; text-align: center;">
                أدخل هذا الرمز في شاشة التحقق لتفعيل حسابك.
              </p>
              <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 24px 0;" />
              <p style="font-size: 13px; color: #9CA3AF;">
                إذا لم تقم بإنشاء حساب في Safi POS، يمكنك تجاهل هذا البريد.
              </p>
            </div>
            <div style="background: #F3F4F6; padding: 16px 24px; border-radius: 0 0 8px 8px;
                        text-align: center; border: 1px solid #E5E7EB; border-top: none;">
              <small style="color: #9CA3AF;">Safi POS — Cloud Cashier System</small>
            </div>
          </div>
        `,
      });
      console.log('OTP sent successfully via Brevo HTTP API');
    } catch (error) {
      console.error('Failed to send OTP via Brevo:', error);
      throw error;
    }
  }

  async sendWelcomeEmail(
    email: string,
    storeName: string,
    subdomain: string,
    username: string,
  ) {
    try {
      await this.send({
        sender: this.sender,
        to: [{ email }],
        subject: `تم قبول متجرك "${storeName}" — Safi POS`,
        htmlContent: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
            <div style="background: #4F46E5; padding: 32px 24px; border-radius: 8px 8px 0 0; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 24px;">أهلاً بك في Safi POS!</h1>
            </div>
            <div style="background: #ffffff; padding: 32px 24px; border: 1px solid #E5E7EB; border-top: none;">
              <p style="font-size: 16px;">مرحباً <b>${username}</b>،</p>
              <p style="font-size: 16px;">
                تهانينا! تمت مراجعة متجرك <b>${storeName}</b> وتمت
                <span style="color: #16A34A; font-weight: bold;">الموافقة عليه</span>.
                يمكنك الآن تسجيل الدخول والبدء باستخدام لوحة التحكم.
              </p>
              <div style="background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 8px; padding: 20px; margin: 24px 0;">
                <p style="margin: 0 0 12px 0; font-weight: bold; color: #374151;">بيانات تسجيل الدخول</p>
                <table style="width: 100%; border-collapse: collapse; font-size: 15px;">
                  <tr>
                    <td style="padding: 6px 0; color: #6B7280; width: 140px;">رابط الدخول</td>
                    <td>
                      <a href="https://${subdomain}.safi-pos.com/login" style="color: #4F46E5; text-decoration: none;">
                        https://${subdomain}.safi-pos.com/login
                      </a>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #6B7280;">الـ Subdomain</td>
                    <td style="font-weight: 600;">${subdomain}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #6B7280;">اسم المستخدم</td>
                    <td style="font-weight: 600;">${username}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #6B7280;">كلمة المرور</td>
                    <td style="color: #6B7280; font-style: italic;">كلمة المرور التي اخترتها عند التسجيل</td>
                  </tr>
                </table>
              </div>
              <div style="text-align: center; margin: 28px 0;">
                <a href="https://${subdomain}.safi-pos.com/login"
                   style="background: #4F46E5; color: #ffffff; padding: 14px 32px;
                          border-radius: 6px; text-decoration: none; font-size: 16px;
                          font-weight: bold; display: inline-block;">
                  الذهاب إلى لوحة التحكم →
                </a>
              </div>
            </div>
            <div style="background: #F3F4F6; padding: 16px 24px; border-radius: 0 0 8px 8px;
                        text-align: center; border: 1px solid #E5E7EB; border-top: none;">
              <small style="color: #9CA3AF;">Safi POS — Cloud Cashier System</small>
            </div>
          </div>
        `,
      });
      this.logger.log(`Welcome email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send welcome email to ${email}`, error);
    }
  }

  async sendPasswordResetEmail(email: string, username: string, resetLink: string) {
    try {
      await this.send({
        sender: this.sender,
        to: [{ email }],
        subject: 'إعادة تعيين كلمة مرور Safi POS',
        htmlContent: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
            <div style="background: #4F46E5; padding: 32px 24px; border-radius: 8px 8px 0 0; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 24px;">طلب إعادة تعيين كلمة المرور</h1>
            </div>
            <div style="background: #ffffff; padding: 32px 24px; border: 1px solid #E5E7EB; border-top: none;">
              <p style="font-size: 16px;">مرحباً <b>${username}</b>،</p>
              <p style="font-size: 16px;">
                تلقينا طلباً لإعادة تعيين كلمة مرورك. اضغط على الزر أدناه لاختيار كلمة مرور جديدة.
                هذا الرابط صالح لمدة <b>ساعة واحدة</b>.
              </p>
              <div style="text-align: center; margin: 32px 0;">
                <a href="${resetLink}"
                   style="background: #4F46E5; color: #ffffff; padding: 14px 32px;
                          border-radius: 6px; text-decoration: none; font-size: 16px;
                          font-weight: bold; display: inline-block;">
                  إعادة تعيين كلمة المرور →
                </a>
              </div>
              <p style="font-size: 14px; color: #6B7280;">أو انسخ هذا الرابط في متصفحك:</p>
              <p style="font-size: 13px; word-break: break-all; color: #4F46E5;">${resetLink}</p>
              <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 24px 0;" />
              <p style="font-size: 13px; color: #9CA3AF;">
                إذا لم تطلب إعادة التعيين، يمكنك تجاهل هذا البريد.
              </p>
            </div>
            <div style="background: #F3F4F6; padding: 16px 24px; border-radius: 0 0 8px 8px;
                        text-align: center; border: 1px solid #E5E7EB; border-top: none;">
              <small style="color: #9CA3AF;">Safi POS — Cloud Cashier System</small>
            </div>
          </div>
        `,
      });
      this.logger.log(`Password reset email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send password reset email to ${email}`, error);
    }
  }

  async sendDebtBackupEmail(
    email: string,
    storeName: string,
    date: string,
    attachments: { filename: string; content: Buffer }[],
  ) {
    try {
      const brevoAttachments: BrevoAttachment[] = attachments.map((a) => ({
        name: a.filename,
        content: a.content.toString('base64'),
      }));

      await this.send({
        sender: this.sender,
        to: [{ email }],
        subject: `تقرير الديون اليومي - ${storeName} — ${date}`,
        htmlContent: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
            <div style="background: #4F46E5; padding: 32px 24px; border-radius: 8px 8px 0 0; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 24px;">نسخة احتياطية للديون اليومية</h1>
            </div>
            <div style="background: #ffffff; padding: 32px 24px; border: 1px solid #E5E7EB; border-top: none;">
              <p style="font-size: 16px;">مرحباً مدير <b>${storeName}</b>،</p>
              <p style="font-size: 16px;">
                يرجى الاطلاع على تقرير الديون اليومي المرفق بتاريخ <b>${date}</b>.
              </p>
              <div style="background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 8px;
                          padding: 16px 20px; margin: 24px 0; text-align: center;">
                <p style="margin: 0; font-size: 14px; color: #6B7280;">
                  <b>المرفق:</b> debt-backup-${date}.pdf
                </p>
              </div>
              <p style="font-size: 14px; color: #6B7280;">
                هذا تقرير تلقائي من Safi POS. لا يلزم اتخاذ أي إجراء ما لم تلاحظ تناقضات.
              </p>
            </div>
            <div style="background: #F3F4F6; padding: 16px 24px; border-radius: 0 0 8px 8px;
                        text-align: center; border: 1px solid #E5E7EB; border-top: none;">
              <small style="color: #9CA3AF;">Safi POS — Cloud Cashier System</small>
            </div>
          </div>
        `,
        attachment: brevoAttachments,
      });
      this.logger.log(`Debt backup email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send debt backup email to ${email}`, error);
      throw error;
    }
  }
}
