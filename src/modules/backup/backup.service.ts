import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { MailService } from '../mail/mail.service';
import * as path from 'path';
import * as fs from 'fs';

interface CustomerDebtRow {
  name: string;
  phone: string | null;
  totalRemaining: Prisma.Decimal;
  debtCount: number;
  oldestDebtDays: number;
}

// Use the short Arabic letter "ش" instead of the Unicode ₪ glyph because the
// embedded Cairo font ships without U+20AA, so on Linux Chromium (Railway)
// the symbol falls back to a "tofu" □ box. A plain Arabic letter renders
// perfectly in any Arabic-capable font.
const CURRENCY = 'ش';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Browsers to try in order. Add Linux paths for production servers. */
const BROWSER_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean) as string[];

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

    // Build the inline email summary so the recipient can act without opening
    // the PDF.
    const zero = new Prisma.Decimal(0);
    const grandTotal = customerRows.reduce(
      (s, r) => s.plus(r.totalRemaining),
      zero,
    );
    const largest = customerRows.reduce(
      (max, r) => (r.totalRemaining.gt(max) ? r.totalRemaining : max),
      zero,
    );
    const largestRow = customerRows.find((r) =>
      r.totalRemaining.equals(largest),
    );
    const oldestDays = customerRows.reduce(
      (max, r) => Math.max(max, r.oldestDebtDays),
      0,
    );

    const fmt = (d: Prisma.Decimal) =>
      Number(d.toFixed(2)).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

    await this.mailService.sendDebtBackupEmail(
      admin.email,
      storeName,
      today,
      {
        debtorCount: customerRows.length,
        grandTotalDisplay: fmt(grandTotal),
        largestDebtDisplay: fmt(largest),
        largestDebtor: largestRow?.name ?? '',
        oldestDebtDays: oldestDays,
        needsAttention: oldestDays > 60,
        topThree: customerRows.slice(0, 3).map((r) => ({
          name: r.name,
          amountDisplay: fmt(r.totalRemaining),
        })),
      },
      [
        {
          filename: `debt-report-${today}.pdf`,
          content: pdfBuffer,
        },
      ],
    );

    this.logger.log(
      `Report sent for "${storeName}" — ${customerRows.length} debtor(s) → ${admin.email}`,
    );

    return {
      message: `تم الإرسال بنجاح إلى ${admin.email} — عدد المديونين: ${customerRows.length}`,
    };
  }

  /**
   * Groups all unpaid debts by customer with the fields the Executive report
   * needs: total remaining, phone, debt count, and the age (in days) of the
   * oldest outstanding debt. Sorted by total descending so the report opens
   * with the biggest debtor.
   */
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
        phone: true,
        debts: {
          where: { isPaid: false },
          select: { remaining: true, date: true },
        },
      },
    });

    const now = Date.now();
    const rows = customers.map<CustomerDebtRow>((c) => {
      const total = c.debts.reduce(
        (acc, d) => acc.plus(new Prisma.Decimal(d.remaining)),
        new Prisma.Decimal(0),
      );
      const oldestMs = c.debts.reduce(
        (min, d) => Math.min(min, d.date.getTime()),
        now,
      );
      const oldestDebtDays = Math.max(0, Math.floor((now - oldestMs) / DAY_MS));

      return {
        name: c.name,
        phone: c.phone,
        totalRemaining: total,
        debtCount: c.debts.length,
        oldestDebtDays,
      };
    });

    rows.sort((a, b) => b.totalRemaining.comparedTo(a.totalRemaining));
    return rows;
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

  // ─── HTML Template (Executive design) ─────────────────────────────────────────
  //
  // Layout:
  //   1. Cover header (navy gradient, store name, date, portfolio status)
  //   2. KPI strip (count, total, largest, oldest)
  //   3. Top-3 callout cards (priority customers to contact)
  //   4. Age-distribution bar chart (4 buckets: ≤7, 8-30, 31-90, >90 days)
  //   5. Full detail table (#, name, phone, debt count, oldest age, amount)
  //   6. Grand total bar + footer
  //
  // The table breaks across pages naturally; we don't use <tfoot> because PDF
  // engines repeat it per page. The grand total lives in a separate bar.

  private buildHtml(
    storeName: string,
    isoDate: string,
    rows: CustomerDebtRow[],
  ): string {
    const dateLong = this.formatLongDate(isoDate);
    const dateShort = this.formatShortDate(isoDate);

    const zero = new Prisma.Decimal(0);
    const grandTotal = rows.reduce((s, r) => s.plus(r.totalRemaining), zero);
    const largest = rows.reduce(
      (max, r) => (r.totalRemaining.gt(max) ? r.totalRemaining : max),
      zero,
    );
    const oldest = rows.reduce((max, r) => Math.max(max, r.oldestDebtDays), 0);
    const needsAttention = oldest > 60;

    // Age buckets for the distribution chart.
    const buckets = {
      fresh:  rows.filter((r) => r.oldestDebtDays <= 7),
      recent: rows.filter((r) => r.oldestDebtDays > 7  && r.oldestDebtDays <= 30),
      aging:  rows.filter((r) => r.oldestDebtDays > 30 && r.oldestDebtDays <= 90),
      stale:  rows.filter((r) => r.oldestDebtDays > 90),
    };

    const top3 = rows.slice(0, 3); // already sorted by amount desc
    const top3Cards = top3
      .map(
        (r, i) => `
        <div class="top-card">
          <div class="rank">#${i + 1}</div>
          <div class="who">
            <div class="who-name">${this.escapeHtml(r.name)}</div>
            <div class="who-phone">${this.escapeHtml(r.phone ?? '—')}</div>
          </div>
          <div class="who-amount">${this.amount(r.totalRemaining)}</div>
        </div>`,
      )
      .join('');

    const bucketBar = (label: string, list: CustomerDebtRow[], color: string) => {
      const sum = list.reduce((s, r) => s.plus(r.totalRemaining), zero);
      const pct = grandTotal.gt(0)
        ? sum.div(grandTotal).times(100).toNumber()
        : 0;
      return `
        <div class="bucket">
          <div class="bucket-head">
            <span class="bucket-label">${label}</span>
            <span class="bucket-meta">${list.length} عميل · ${this.amount(sum)}</span>
          </div>
          <div class="bucket-bar"><div class="bucket-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div></div>
        </div>`;
    };

    const tableRows = rows
      .map((r, i) => {
        const age = this.ageBadge(r.oldestDebtDays);
        return `
        <tr>
          <td class="idx">${i + 1}</td>
          <td class="name">${this.escapeHtml(r.name)}</td>
          <td class="phone"><span dir="ltr">${this.escapeHtml(r.phone ?? '—')}</span></td>
          <td class="cnt">${r.debtCount}</td>
          <td><span class="age" style="color:${age.color};background:${age.bg}">${this.ageLabel(r.oldestDebtDays)}</span></td>
          <td class="amount">${this.amount(r.totalRemaining)}</td>
        </tr>`;
      })
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
  @page { size: A4; margin: 0; }
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Cairo', system-ui, sans-serif; color: #1E293B; background: #fff; font-size: 13px; line-height: 1.5; }

  /* ── Cover ── */
  .cover { background: linear-gradient(135deg, #0F172A 0%, #1E3A8A 100%); color: #fff; padding: 40px 36px 32px; }
  .cover .brand { font-size: 11px; color: #93C5FD; letter-spacing: 2px; text-transform: uppercase; font-weight: 600; }
  .cover h1 { font-size: 32px; font-weight: 800; margin-top: 4px; }
  .cover .sub { font-size: 14px; color: #BFDBFE; margin-top: 8px; }
  .cover-meta { display: flex; gap: 36px; margin-top: 24px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.15); }
  .cover-meta .item .lbl { font-size: 10px; color: #93C5FD; text-transform: uppercase; letter-spacing: 1px; font-weight: 600; }
  .cover-meta .item .val { font-size: 16px; font-weight: 700; margin-top: 4px; }

  /* ── KPI strip ── */
  .kpis-strip { background: #F8FAFC; padding: 20px 36px; display: flex; justify-content: space-around; border-bottom: 1px solid #E2E8F0; }
  .kpi { text-align: center; }
  .kpi .lbl { font-size: 11px; color: #64748B; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
  .kpi .val { font-size: 26px; font-weight: 800; color: #0F172A; margin-top: 4px; }
  .kpi .val.warn { color: #B45309; }
  .kpi .val .unit { font-size: 12px; color: #94A3B8; font-weight: 500; }

  /* ── Section ── */
  .section { padding: 24px 36px; }
  .section-title { font-size: 13px; font-weight: 700; color: #0F172A; margin-bottom: 12px; padding-right: 8px; border-right: 3px solid #B45309; }

  /* ── Top-3 cards ── */
  .top-list { display: flex; flex-direction: column; gap: 8px; }
  .top-card { display: flex; align-items: center; gap: 16px; padding: 12px 16px; background: linear-gradient(90deg, #FEF3C7 0%, #FFFBEB 100%); border-right: 3px solid #B45309; border-radius: 4px; }
  .top-card .rank { font-size: 18px; font-weight: 800; color: #B45309; min-width: 32px; }
  .top-card .who { flex: 1; }
  .top-card .who-name { font-weight: 700; color: #0F172A; }
  .top-card .who-phone { font-size: 11px; color: #64748B; direction: ltr; text-align: right; margin-top: 2px; font-family: ui-monospace, monospace; }
  .top-card .who-amount { font-size: 18px; font-weight: 800; color: #B45309; }
  .top-card .who-amount .curr { font-size: 12px; color: #92400E; font-weight: 500; }

  /* ── Buckets ── */
  .buckets { display: flex; flex-direction: column; gap: 10px; }
  .bucket-head { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; }
  .bucket-label { font-weight: 600; color: #1E293B; }
  .bucket-meta { color: #64748B; }
  .bucket-bar { height: 8px; background: #F1F5F9; border-radius: 999px; overflow: hidden; }
  .bucket-fill { height: 100%; border-radius: 999px; }

  /* ── Detail table ── */
  .detail-section { padding: 24px 36px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  thead th { background: #0F172A; color: #fff; font-size: 11px; font-weight: 600; padding: 10px 8px; text-align: right; }
  thead th:first-child, thead th:nth-child(4) { text-align: center; }
  thead th:last-child { text-align: left; }
  tbody td { padding: 9px 8px; border-bottom: 1px solid #E2E8F0; vertical-align: middle; }
  tbody tr { page-break-inside: avoid; }
  tbody tr:nth-child(even) { background: #F8FAFC; }
  .idx { color: #94A3B8; text-align: center; font-variant-numeric: tabular-nums; width: 36px; }
  .name { font-weight: 600; color: #0F172A; }
  .phone { font-family: ui-monospace, monospace; text-align: right; color: #475569; }
  .cnt { text-align: center; color: #475569; }
  .age { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
  .amount { text-align: left; font-weight: 700; color: #B45309; font-variant-numeric: tabular-nums; }
  .amount .curr { font-size: 11px; color: #92400E; font-weight: 500; }

  /* ── Grand total ── */
  .grand { background: #0F172A; color: #fff; padding: 14px 36px; display: flex; justify-content: space-between; align-items: center; }
  .grand .lbl { font-size: 13px; font-weight: 600; }
  .grand .val { font-size: 22px; font-weight: 800; color: #FCD34D; }
  .grand .val .curr { color: #FDE68A; font-weight: 500; font-size: 14px; }

  .footer { padding: 14px 36px; background: #F8FAFC; text-align: center; font-size: 10px; color: #94A3B8; }
</style>
</head>
<body>

<div class="cover">
  <div class="brand">Safi POS — Daily Debt Report</div>
  <h1>${this.escapeHtml(storeName)}</h1>
  <div class="sub">تقرير الديون اليومي</div>
  <div class="cover-meta">
    <div class="item"><div class="lbl">تاريخ التقرير</div><div class="val">${dateLong}</div></div>
    <div class="item"><div class="lbl">حالة المحفظة</div><div class="val">${needsAttention ? '⚠ تتطلب متابعة' : '✓ تحت السيطرة'}</div></div>
  </div>
</div>

<div class="kpis-strip">
  <div class="kpi"><div class="lbl">عدد المديونين</div><div class="val">${rows.length}</div></div>
  <div class="kpi"><div class="lbl">الإجمالي المتبقي</div><div class="val warn">${this.amount(grandTotal)}</div></div>
  <div class="kpi"><div class="lbl">أكبر مديونية</div><div class="val">${this.amount(largest)}</div></div>
  <div class="kpi"><div class="lbl">أقدم دين</div><div class="val">${oldest === 0 ? 'اليوم' : `${oldest} <span class="unit">يوم</span>`}</div></div>
</div>

${top3.length > 0 ? `
<div class="section">
  <div class="section-title">الأولوية القصوى — أكبر ${top3.length} مديونيات</div>
  <div class="top-list">${top3Cards}</div>
</div>` : ''}

<div class="section">
  <div class="section-title">توزيع الديون حسب العمر</div>
  <div class="buckets">
    ${bucketBar('آخر 7 أيام',     buckets.fresh,  '#10B981')}
    ${bucketBar('8 إلى 30 يوم',  buckets.recent, '#F59E0B')}
    ${bucketBar('31 إلى 90 يوم', buckets.aging,  '#F97316')}
    ${bucketBar('أكثر من 90 يوم', buckets.stale,  '#DC2626')}
  </div>
</div>

<div class="detail-section">
  <div class="section-title">قائمة المديونين الكاملة</div>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>الاسم</th>
        <th>الهاتف</th>
        <th>الديون</th>
        <th>أقدم دين</th>
        <th>المتبقي</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
</div>

<div class="grand">
  <div class="lbl">الإجمالي العام · ${rows.length} عميل</div>
  <div class="val">${this.amount(grandTotal)}</div>
</div>

<div class="footer">Safi POS · ${dateShort} · هذا تقرير تلقائي يومي. لمراجعة التفاصيل افتح لوحة التحكم.</div>

</body>
</html>`;
  }

  // ─── Formatting helpers ──────────────────────────────────────────────────────

  /**
   * Renders a Decimal as "1,234.56 ش".
   *
   * BiDi care: the digits must stay LTR (so the thousands separator and dot
   * read correctly) while "ش" must stay RTL. Wrapping the whole thing in a
   * single `dir="ltr"` span made the Arabic abbreviation flip in front of the
   * number on Linux Chromium (the BiDi algorithm groups consecutive Arabic
   * characters into an RTL run). The fix: isolate only the digits with `<bdi
   * dir="ltr">` and leave the currency abbreviation in its natural direction.
   */
  private amount(d: Prisma.Decimal): string {
    const n = Number(d.toFixed(2));
    const formatted = n.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `<bdi dir="ltr">${formatted}</bdi> <span class="curr">${CURRENCY}</span>`;
  }

  /** "الجمعة، 22 مايو 2026" — full Arabic weekday + day + month + year. */
  private formatLongDate(iso: string): string {
    try {
      return new Intl.DateTimeFormat('ar-EG', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }

  /** "22/05/2026" — compact numeric form used in the footer. */
  private formatShortDate(iso: string): string {
    try {
      return new Intl.DateTimeFormat('en-GB').format(new Date(iso));
    } catch {
      return iso;
    }
  }

  /**
   * Renders an age-in-days as an Arabic label. Zero days reads naturally as
   * "اليوم" instead of the stilted "0 يوم".
   */
  private ageLabel(days: number): string {
    if (days === 0) return 'اليوم';
    return `${days} يوم`;
  }

  /**
   * Maps an age in days to one of four colour buckets used by the age badge.
   * Kept here (vs. inline) so the same scale can drive the bucket bar chart
   * with the same colours.
   */
  private ageBadge(days: number): { color: string; bg: string } {
    if (days <= 7)  return { color: '#10B981', bg: '#D1FAE5' };
    if (days <= 30) return { color: '#F59E0B', bg: '#FEF3C7' };
    if (days <= 90) return { color: '#F97316', bg: '#FED7AA' };
    return                  { color: '#DC2626', bg: '#FEE2E2' };
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
