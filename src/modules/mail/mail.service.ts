import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import type { Attachment } from 'nodemailer/lib/mailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend = new Resend(process.env.RESEND_API_KEY);
  private readonly from = process.env.MAIL_FROM ?? 'Safi POS <noreply@safi-pos.com>';

  async sendEmailVerificationOtp(email: string, username: string, otp: string) {
    try {
      await this.resend.emails.send({
        from: this.from,
        to: email,
        subject: 'Verify Your Email — Safi POS',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
            <div style="background: #4F46E5; padding: 32px 24px; border-radius: 8px 8px 0 0; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 24px;">Verify Your Email</h1>
            </div>

            <div style="background: #ffffff; padding: 32px 24px; border: 1px solid #E5E7EB; border-top: none;">
              <p style="font-size: 16px;">Hi <b>${username}</b>,</p>
              <p style="font-size: 16px;">
                Thanks for registering on Safi POS! Use the code below to verify your email address.
                This code is valid for <b>15 minutes</b>.
              </p>

              <div style="text-align: center; margin: 32px 0;">
                <div style="display: inline-block; background: #F3F4F6; border: 2px dashed #4F46E5;
                            border-radius: 12px; padding: 20px 40px;">
                  <p style="margin: 0; font-size: 13px; color: #6B7280; letter-spacing: 1px;">
                    YOUR VERIFICATION CODE
                  </p>
                  <p style="margin: 8px 0 0 0; font-size: 42px; font-weight: bold;
                            letter-spacing: 12px; color: #4F46E5;">
                    ${otp}
                  </p>
                </div>
              </div>

              <p style="font-size: 14px; color: #6B7280; text-align: center;">
                Enter this code on the verification screen to activate your account.
              </p>

              <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 24px 0;" />
              <p style="font-size: 13px; color: #9CA3AF;">
                If you did not create a Safi POS account, you can safely ignore this email.
              </p>
            </div>

            <div style="background: #F3F4F6; padding: 16px 24px; border-radius: 0 0 8px 8px;
                        text-align: center; border: 1px solid #E5E7EB; border-top: none;">
              <small style="color: #9CA3AF;">Safi POS — Cloud Cashier System</small>
            </div>
          </div>
        `,
      });
    } catch (error) {
      this.logger.error(`Failed to send OTP email to ${email}`, error);
    }
  }

  async sendWelcomeEmail(
    email: string,
    storeName: string,
    subdomain: string,
    username: string,
  ) {
    try {
      await this.resend.emails.send({
        from: this.from,
        to: email,
        subject: `Your store "${storeName}" has been approved — Safi POS`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
            <div style="background: #4F46E5; padding: 32px 24px; border-radius: 8px 8px 0 0; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 24px;">Welcome to Safi POS!</h1>
            </div>

            <div style="background: #ffffff; padding: 32px 24px; border: 1px solid #E5E7EB; border-top: none;">
              <p style="font-size: 16px;">Hi <b>${username}</b>,</p>
              <p style="font-size: 16px;">
                Great news! Your store <b>${storeName}</b> has been reviewed and
                <span style="color: #16A34A; font-weight: bold;">approved</span>.
                You can now log in and start using your dashboard.
              </p>

              <div style="background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 8px; padding: 20px; margin: 24px 0;">
                <p style="margin: 0 0 12px 0; font-weight: bold; color: #374151;">Your Login Details</p>
                <table style="width: 100%; border-collapse: collapse; font-size: 15px;">
                  <tr>
                    <td style="padding: 6px 0; color: #6B7280; width: 140px;">Login URL</td>
                    <td>
                      <a href="https://${subdomain}.safi-pos.com/login"
                         style="color: #4F46E5; text-decoration: none;">
                        https://${subdomain}.safi-pos.com/login
                      </a>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #6B7280;">Store Subdomain</td>
                    <td style="font-weight: 600;">${subdomain}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #6B7280;">Username</td>
                    <td style="font-weight: 600;">${username}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #6B7280;">Password</td>
                    <td style="color: #6B7280; font-style: italic;">The password you set during registration</td>
                  </tr>
                </table>
              </div>

              <div style="text-align: center; margin: 28px 0;">
                <a href="https://${subdomain}.safi-pos.com/login"
                   style="background: #4F46E5; color: #ffffff; padding: 14px 32px;
                          border-radius: 6px; text-decoration: none; font-size: 16px;
                          font-weight: bold; display: inline-block;">
                  Go to My Dashboard →
                </a>
              </div>

              <p style="font-size: 14px; color: #6B7280;">
                If you did not register for Safi POS, you can safely ignore this email.
              </p>
            </div>

            <div style="background: #F3F4F6; padding: 16px 24px; border-radius: 0 0 8px 8px;
                        text-align: center; border: 1px solid #E5E7EB; border-top: none;">
              <small style="color: #9CA3AF;">Safi POS — Cloud Cashier System</small>
            </div>
          </div>
        `,
      });
    } catch (error) {
      this.logger.error(`Failed to send approval email to ${email}`, error);
    }
  }

  async sendPasswordResetEmail(
    email: string,
    username: string,
    resetLink: string,
  ) {
    try {
      await this.resend.emails.send({
        from: this.from,
        to: email,
        subject: 'Reset Your Safi POS Password',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
            <div style="background: #4F46E5; padding: 32px 24px; border-radius: 8px 8px 0 0; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 24px;">Password Reset Request</h1>
            </div>

            <div style="background: #ffffff; padding: 32px 24px; border: 1px solid #E5E7EB; border-top: none;">
              <p style="font-size: 16px;">Hi <b>${username}</b>,</p>
              <p style="font-size: 16px;">
                We received a request to reset your password. Click the button below to choose a new one.
                This link will expire in <b>1 hour</b>.
              </p>

              <div style="text-align: center; margin: 32px 0;">
                <a href="${resetLink}"
                   style="background: #4F46E5; color: #ffffff; padding: 14px 32px;
                          border-radius: 6px; text-decoration: none; font-size: 16px;
                          font-weight: bold; display: inline-block;">
                  Reset My Password →
                </a>
              </div>

              <p style="font-size: 14px; color: #6B7280;">
                Or copy and paste this link into your browser:
              </p>
              <p style="font-size: 13px; word-break: break-all; color: #4F46E5;">${resetLink}</p>

              <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 24px 0;" />
              <p style="font-size: 13px; color: #9CA3AF;">
                If you didn't request a password reset, you can safely ignore this email.
                Your password will not be changed.
              </p>
            </div>

            <div style="background: #F3F4F6; padding: 16px 24px; border-radius: 0 0 8px 8px;
                        text-align: center; border: 1px solid #E5E7EB; border-top: none;">
              <small style="color: #9CA3AF;">Safi POS — Cloud Cashier System</small>
            </div>
          </div>
        `,
      });
    } catch (error) {
      this.logger.error(`Failed to send password reset email to ${email}`, error);
    }
  }

  async sendDebtBackupEmail(
    email: string,
    storeName: string,
    date: string,
    attachments: Attachment[],
  ) {
    try {
      await this.resend.emails.send({
        from: this.from,
        to: email,
        subject: `Daily Debt Backup - ${storeName} — ${date}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
            <div style="background: #4F46E5; padding: 32px 24px; border-radius: 8px 8px 0 0; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 24px;">Daily Debt Backup</h1>
            </div>

            <div style="background: #ffffff; padding: 32px 24px; border: 1px solid #E5E7EB; border-top: none;">
              <p style="font-size: 16px;">Hi <b>${storeName}</b> Admin,</p>
              <p style="font-size: 16px;">
                Please find attached the daily debt backup report for
                <b>${date}</b>. This PDF contains all outstanding debts
                currently recorded for your store.
              </p>

              <div style="background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 8px;
                          padding: 16px 20px; margin: 24px 0; text-align: center;">
                <p style="margin: 0; font-size: 14px; color: #6B7280;">
                  <b>Attachment:</b> debt-backup-${date}.pdf
                </p>
              </div>

              <p style="font-size: 14px; color: #6B7280;">
                This is an automated report generated by Safi POS.
                No action is required unless you notice discrepancies.
              </p>
            </div>

            <div style="background: #F3F4F6; padding: 16px 24px; border-radius: 0 0 8px 8px;
                        text-align: center; border: 1px solid #E5E7EB; border-top: none;">
              <small style="color: #9CA3AF;">Safi POS — Cloud Cashier System</small>
            </div>
          </div>
        `,
        attachments: attachments.map((a) => ({
          filename: a.filename as string,
          content: a.content as Buffer,
        })),
      });
    } catch (error) {
      this.logger.error(
        `Failed to send debt backup email to ${email}`,
        error,
      );
      throw error;
    }
  }
}
