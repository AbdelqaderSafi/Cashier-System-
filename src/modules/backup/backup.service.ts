import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service';
import { MailService } from '../mail/mail.service';
import * as path from 'path';
import * as fs from 'fs';

interface CustomerDebtRow {
  customerName: string;
  totalRemaining: string;
}

/** Browsers to try in order. Add Linux paths for production servers. */
const BROWSER_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  private readonly fontBase64 = {
    cairo: this.loadFontBase64('Cairo-Variable.ttf'),
  };

  constructor(
    private readonly db: DatabaseService,
    private readonly mailService: MailService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleDailyDebtBackup() {
    this.logger.log('Starting daily debt backup cron job...');

    let stores: { id: string; name: string }[];
    try {
      stores = await this.db.store.findMany({
        where: { status: 'APPROVED' },
        select: { id: true, name: true },
      });
    } catch (error) {
      this.logger.error('Failed to fetch active stores', error);
      return;
    }

    this.logger.log(`Found ${stores.length} active store(s) to process.`);

    for (const store of stores) {
      try {
        const result = await this.processStoreBackup(store.id, store.name);
        this.logger.log(`[${store.name}] ${result.message}`);
      } catch (error) {
        this.logger.error(
          `Backup failed for store "${store.name}" (${store.id})`,
          error,
        );
      }
    }

    this.logger.log('Daily debt backup cron job completed.');
  }

  /** Called by the controller for on-demand backup of a single store. */
  async triggerForStore(storeId: string): Promise<{ message: string }> {
    const store = await this.db.store.findUnique({
      where: { id: storeId },
      select: { id: true, name: true },
    });

    if (!store) return { message: 'المتجر غير موجود' };
    return this.processStoreBackup(store.id, store.name);
  }

  // ─── Core Logic ───────────────────────────────────────────────────────────────

  private async processStoreBackup(
    storeId: string,
    storeName: string,
  ): Promise<{ message: string }> {
    const admin = await this.db.user.findFirst({
      where: { storeId, role: 'ADMIN' },
      select: { email: true },
    });

    if (!admin?.email) {
      this.logger.warn(`Store "${storeName}" has no admin email — skipping.`);
      return { message: 'لم يتم العثور على إيميل للمدير' };
    }

    const customerRows = await this.fetchCustomerDebts(storeId);

    if (customerRows.length === 0) {
      return { message: 'لا توجد ديون غير مسددة — لم يتم إرسال أي بريد' };
    }

    const today = new Date().toISOString().split('T')[0];
    const pdfBuffer = await this.generatePdf(storeName, today, customerRows);

    await this.mailService.sendDebtBackupEmail(admin.email, storeName, today, [
      {
        filename: `debt-report-${today}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ]);

    this.logger.log(
      `Report sent for "${storeName}" — ${customerRows.length} debtor(s) → ${admin.email}`,
    );

    return {
      message: `تم الإرسال بنجاح إلى ${admin.email} — عدد المديونين: ${customerRows.length}`,
    };
  }

  /** Groups all unpaid debts by customer, returns name + remaining only. */
  private async fetchCustomerDebts(
    storeId: string,
  ): Promise<CustomerDebtRow[]> {
    const customers = await this.db.customer.findMany({
      where: {
        storeId,
        debts: { some: { isPaid: false } },
      },
      select: {
        name: true,
        debts: {
          where: { isPaid: false },
          select: { remaining: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    return customers.map((c) => ({
      customerName: c.name,
      totalRemaining: c.debts
        .reduce((sum, d) => sum + Number(d.remaining), 0)
        .toFixed(2),
    }));
  }

  // ─── PDF Generation ───────────────────────────────────────────────────────────

  private async generatePdf(
    storeName: string,
    date: string,
    customerRows: CustomerDebtRow[],
  ): Promise<Buffer> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const puppeteer = require('puppeteer') as typeof import('puppeteer');

    const executablePath = this.findBrowser();
    const launchOptions = executablePath
      ? { executablePath, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
      : { args: ['--no-sandbox', '--disable-setuid-sandbox'] };

    const browser = await puppeteer.launch(launchOptions);
    try {
      const page = await browser.newPage();
      await page.setContent(this.buildHtml(storeName, date, customerRows), {
        waitUntil: 'networkidle0',
      });
      const pdfBytes = await page.pdf({
        format: 'A4',
        landscape: false,
        printBackground: true,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
      });
      return Buffer.from(pdfBytes);
    } finally {
      await browser.close();
    }
  }

  private findBrowser(): string | undefined {
    return BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
  }

  // ─── HTML Template ────────────────────────────────────────────────────────────

  private buildHtml(
    storeName: string,
    date: string,
    rows: CustomerDebtRow[],
  ): string {
    const grandTotal = rows
      .reduce((s, r) => s + parseFloat(r.totalRemaining), 0)
      .toFixed(2);

    const tableRows = rows
      .map(
        (r, i) => `
        <tr>
          <td class="idx">${i + 1}</td>
          <td class="name">${this.escapeHtml(r.customerName)}</td>
          <td class="amount">${r.totalRemaining}</td>
        </tr>`,
      )
      .join('');

    return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8"/>
<style>
  @font-face {
    font-family: 'Cairo';
    src: url('data:font/truetype;base64,${this.fontBase64.cairo}') format('truetype');
    font-weight: 100 900;
  }

  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Cairo', Tahoma, sans-serif;
    font-size: 16px;
    color: #1F2937;
    background: #fff;
    direction: rtl;
  }

  /* ── Header ── */
  .header {
    background: linear-gradient(135deg, #4F46E5, #7C3AED);
    color: #fff;
    padding: 30px 40px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .header h1  { font-size: 28px; font-weight: 800; }
  .header p   { font-size: 14px; color: #C7D2FE; margin-top: 5px; }
  .header .badge {
    background: rgba(255,255,255,0.15);
    border-radius: 12px;
    padding: 12px 22px;
    text-align: center;
  }
  .header .badge .lbl { font-size: 12px; color: #C7D2FE; }
  .header .badge .val { font-size: 20px; font-weight: 700; }

  /* ── Summary bar ── */
  .summary {
    background: #FEF3C7;
    border-top: 3px solid #F59E0B;
    border-bottom: 3px solid #F59E0B;
    display: flex;
    justify-content: space-around;
    padding: 16px 40px;
  }
  .summary .s-item { text-align: center; }
  .summary .s-lbl  { font-size: 13px; color: #92400E; font-weight: 600; }
  .summary .s-val  { font-size: 24px; font-weight: 800; color: #92400E; direction: ltr; }
  .summary .s-val.red { color: #DC2626; }

  /* ── Table ── */
  .table-wrap { padding: 28px 40px 32px; }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 16px;
  }
  thead tr { background: #1E1B4B; color: #fff; }
  thead th {
    padding: 15px 18px;
    font-size: 16px;
    font-weight: 700;
    text-align: center;
  }
  thead th.th-name { text-align: right; }

  tbody tr { border-bottom: 1px solid #E5E7EB; }
  tbody tr:nth-child(even) { background: #F9FAFB; }
  tbody tr:nth-child(odd)  { background: #FFFFFF; }

  td.idx    { width: 52px; text-align: center; color: #9CA3AF; font-size: 15px; }
  td.name   { font-size: 18px; font-weight: 700; padding: 13px 18px; color: #111827; }
  td.amount {
    text-align: center;
    direction: ltr;
    font-size: 20px;
    font-weight: 800;
    color: #DC2626;
    padding: 13px 18px;
    width: 160px;
  }

  /* ── Footer row ── */
  tfoot tr { background: #1E1B4B; }
  tfoot td {
    padding: 15px 18px;
    font-weight: 700;
    font-size: 16px;
    color: #fff;
    text-align: center;
  }
  tfoot .tf-lbl { text-align: right; font-size: 17px; }
  tfoot .tf-total {
    font-size: 22px;
    color: #FCA5A5;
    direction: ltr;
  }

  /* ── Page footer ── */
  .footer {
    text-align: center;
    color: #9CA3AF;
    font-size: 13px;
    padding: 16px 40px 20px;
    border-top: 1px solid #E5E7EB;
  }
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>${this.escapeHtml(storeName)}</h1>
    <p>تقرير الديون المتراكمة — Safi POS</p>
  </div>
  <div class="badge">
    <div class="lbl">تاريخ التقرير</div>
    <div class="val">${date}</div>
  </div>
</div>

<div class="summary">
  <div class="s-item">
    <div class="s-lbl">عدد المديونين</div>
    <div class="s-val">${rows.length}</div>
  </div>
  <div class="s-item">
    <div class="s-lbl">إجمالي المبالغ المتبقية</div>
    <div class="s-val red">${grandTotal}</div>
  </div>
</div>

<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th class="th-name">اسم العميل</th>
        <th>المبلغ المتبقي</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
    <tfoot>
      <tr>
        <td colspan="2" class="tf-lbl">الإجمالي</td>
        <td class="tf-total">${grandTotal}</td>
      </tr>
    </tfoot>
  </table>
</div>

<div class="footer">
  Safi POS &nbsp;·&nbsp; تقرير تلقائي &nbsp;·&nbsp; ${date} &nbsp;·&nbsp; ${rows.length} عميل مدين
</div>

</body>
</html>`;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private loadFontBase64(filename: string): string {
    const fontPath = path.join(process.cwd(), 'assets', 'fonts', filename);
    try {
      return fs.readFileSync(fontPath).toString('base64');
    } catch {
      this.logger.warn(`Font not found: ${fontPath}`);
      return '';
    }
  }
}
