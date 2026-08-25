# رصيد الزبون — مواصفة التصميم

- **التاريخ:** 2026-08-23
- **الحالة:** معتمد — جاهز لخطة التنفيذ
- **الفرع:** `feat/debt-management`
- **النطاق:** الباك‌إند فقط (NestJS + Prisma). الواجهة مشروع منفصل وجاهزة مسبقاً.
- **يبني على:** [invoice-discount](2026-08-10-invoice-discount-design.md) — نفس الفرع، نفس قيود البرودكشن.
- **مرجع الواجهة:** `Customer Credit Balance Backend Handoff` بتاريخ 2026-08-22.

---

## ١. الخلفية

طلب صاحب المحل حرفياً:

> لو حدا اجا يسد الدين وكان عليه ١٠٠ شيكل دين ودفع مثلاً ١٥٠ شيكل، يصير بحسابه +٥٠. ولما يكون عليه دين يصير الدين بالسالب.

يعني: رصيد واحد موحّد للزبون. **سالب = عليه دين. موجب = المحل مدين له.**

اليوم النظام بيرفض هالحالة من مكانين صريحين في `debt.service.ts`:

```ts
// payForCustomer — السطر ٣٥٠
throw new BadRequestException('لا توجد ديون غير مسددة لهذا العميل');
// payForCustomer — السطر ٣٥٩
throw new BadRequestException(`المبلغ المدفوع (...) يتجاوز إجمالي الديون المتبقية (...)`);
```

الكاشير بياخد ١٥٠ شيكل بإيده والنظام بيرفض يسجّلها. هذا هو الخلل المُصلَّح.

**القيد الحاكم:** نفس قيد carton-sales و invoice-discount. الموقع شغّال على البرودكشن وعليه بيانات حقيقية، و`main` مربوط بـ Railway فأي دمج بينشر مباشرة والميجريشن بتشتغل على `CMD` الكونتينر. الميجريشن لازم تكون إضافة صرفة.

**قيد إضافي خاص بهذه المواصفة:** الواجهة **مبنية على عقد الـ handoff مسبقاً**. كل حقل ومسار موجود اليوم بيضل باسمه ونوعه ومعناه بالحرف. كل الجديد إضافي بحت.

---

## ٢. القرارات المعتمدة

| القرار | الاختيار |
|---|---|
| استخدام الرصيد | **يتخصم تلقائياً من أول دين جديد** — لا دفع بالكاشير، لا استرداد كاش |
| موقع التخزين | **هجين** — عمود على `customers` + جدول سجل `credit_entries` |
| المقبوضات اليومية | **١٥٠ تُسجَّل كاملة**، وسطر مستقل يبيّن الـ ٥٠ كرصيد زبائن |
| دفعة بلا دين | **مقبولة** — كامل المبلغ يصير رصيد |
| حذف دفعة ولّدت رصيداً انصرف | **يُمنع** برسالة عربية واضحة |
| حذف/تعديل فاتورة أكلت رصيداً | **الرصيد يرجع للزبون تلقائياً** بنفس الترانزاكشن |
| المزامنة الأوف‌لاين | **خارج النطاق** — مسار `sync/push` ما بينلمس |
| تقارير الديون | **أرقام صافية جديدة** بجانب القديمة، والقديمة ما بتتغيّر |
| تسوية يدوية للرصيد | **خارج النطاق** — لا endpoint لتعديل الرصيد مباشرة |

---

## ٣. قاعدة البيانات

### ٣.١ ليش الرصيد ما بينحفظ داخل `debts`

القيد الموجود منذ `20260522114500_add_ledger_check_constraints`:

```sql
CHECK (paid + remaining = amount AND paid >= 0 AND remaining >= 0)
```

السقف `paid <= amount` مشتق: بما إن `remaining = amount − paid` و `remaining >= 0`. يعني **مستحيل فيزيائياً** تخزّن دفعة زائدة داخل صف الدين. الفائض لازم يعيش في مكان تاني.

ونفس الشي على `invoices`: `CHECK (... AND total > 0)` بيمنع أي فاتورة صفرية أو سالبة، فما في طريقة نمثّل الرصيد كفاتورة استرداد.

### ٣.٢ عمود جديد على `customers`

```prisma
model Customer {
  // ... الحقول الحالية
  creditBalance Decimal                @default(0) @db.Decimal(10, 2)   // غير سالب أبداً
  creditEntries CreditEntry[]
  paymentOps    DebtPaymentOperation[]
}
```

قيمة افتراضية ثابتة → metadata-only في بوسطجرس ١١+، فورية وبدون إعادة كتابة الجدول. كل زبون موجود بيقرأ `0` تلقائياً.

**ليش عمود وليس `SUM` على السجل:** كل قراءات الزبون في `customer.service.ts` و `sync.service.ts` بترجّع الصف كامل بدون `select`، فالعمود بيوصل للواجهة وللمزامنة الأوف‌لاين مجاناً. السجل لحاله كان بيتطلب `groupBy` في كل قراءة ومصفوفة جديدة في عقد الـ sync.

### ٣.٣ مميّز مصدر الدفعة

```prisma
enum PaymentSource { CASH  CREDIT }

model DebtPayment {
  // ... الحقول الحالية
  source      PaymentSource         @default(CASH)
  operationId String?
  operation   DebtPaymentOperation? @relation(fields: [operationId], references: [id])
  creditEntry CreditEntry?
}
```

`source` **مش تحسينة، هو شرط صحة**. بدونه:
- دفعة ممولة من الرصيد بتتحسب دخل كاش في التقارير.
- `deletePayment` بتحذفها وتدمّر فلوس الزبون بصمت.
- حرّاس تعديل/حذف الفاتورة (`payments.length > 0`) بتنطلق على فاتورة ما دفع فيها حدا ولا شيكل.

### ٣.٤ صف العملية — مرساة الـ idempotency

```prisma
model DebtPaymentOperation {
  id                String   @id @default(uuid())
  clientOperationId String?
  amount            Decimal  @db.Decimal(10, 2)
  date              DateTime @default(now())

  customerId String
  customer   Customer @relation(fields: [customerId], references: [id])          // RESTRICT
  storeId    String
  store      Store    @relation(fields: [storeId], references: [id], onDelete: Cascade)

  payments      DebtPayment[]
  creditEntries CreditEntry[]

  @@unique([storeId, clientOperationId])
  @@index([storeId, customerId, date(sort: Desc)])
  @@map("debt_payment_operations")
}
```

**ليش صف منفصل ومش عمود على `debt_payments`:** العملية الواحدة بتولّد N دفعات (توزيع على ديون متعددة) زائد حركة رصيد. ما في صف موجود يمثّل "العملية". وزيادة على هيك `DebtPayment` أصلاً ما عنده `storeId`، فما بيقدر يحمل `@@unique([storeId, clientOperationId])`.

المفتاح nullable و`UNIQUE` — بوسطجرس بيعامل الـ `NULL`ات كقيم مختلفة، فالطلبات بدون مفتاح ما بتتصادم. نفس النمط الموجود في `invoices_storeId_clientInvoiceId_key` و `customers_storeId_clientCustomerId_key`.

**صف العملية بينكتب دايماً**، حتى لو ما في فائض ولا مفتاح — عشان يضل في مرساة واحدة لكل عملية دفع.

**`operationId = NULL` على دفعة معناه: دفعة ما إلها عملية** — كل الدفعات اللي قبل الميجريشن، وكل الدفعات اللي بيكتبها `sync/push`. هالدفعات بحكم التعريف **ما ولّدت فائضاً**، فسلوكها في الحذف هو السلوك الحالي حرفياً.

### ٣.٥ سجل حركات الرصيد

```prisma
enum CreditReason {
  OVERPAYMENT           // + دفع زائد صار رصيد
  OVERPAYMENT_REVERSED  // − سحب الفائض (حذف دفعة كاش)
  APPLIED_TO_DEBT       // − رصيد انصرف على دين
  APPLIED_REVERSED      // + إرجاع رصيد (حذف/تعديل فاتورة، حذف دفعة رصيد)
}

model CreditEntry {
  id           String       @id @default(uuid())
  delta        Decimal      @db.Decimal(10, 2)
  balanceAfter Decimal      @db.Decimal(10, 2)
  reason       CreditReason
  notes        String?
  date         DateTime     @default(now())

  customerId    String
  customer      Customer @relation(fields: [customerId], references: [id])       // RESTRICT
  storeId       String
  store         Store    @relation(fields: [storeId], references: [id], onDelete: Cascade)
  debtPaymentId String?      @unique
  debtPayment   DebtPayment? @relation(fields: [debtPaymentId], references: [id], onDelete: SetNull)
  operationId   String?
  operation     DebtPaymentOperation? @relation(fields: [operationId], references: [id])

  @@index([storeId, customerId, date(sort: Desc)])
  @@index([storeId, reason, date(sort: Desc)])   // للتقارير اليومية
  @@index([customerId])
  @@map("credit_entries")
}
```

**الأربع قيم في `CreditReason` اتجاهية عمداً.** قيمة `REVERSAL` واحدة كانت بتخدم اتجاهين متعاكسين (إرجاع رصيد للزبون مقابل سحبه منه)، وبكده التقارير في بند ٩.٢ ما بتقدر تعرف أي دلو يحطها فيه. الفصل بيخلي كل تقرير تجميعة على مجموعة أسباب صريحة.

**الاتجاه ملزَم:** `OVERPAYMENT` و `APPLIED_REVERSED` دايماً `delta > 0`. `APPLIED_TO_DEBT` و `OVERPAYMENT_REVERSED` دايماً `delta < 0`.

`customerId` على `RESTRICT` مطابقة لـ `debts` — عشان حذف زبون ما يمحي سجل فلوس. `storeId` على `CASCADE` مطابقة لكل الجداول. `debtPaymentId` على `SetNull` لأن `debt_payments` بينحذف بالـ CASCADE مع الفاتورة، والسجل لازم يعيش بعده.

الفهارس مطابقة للنمط المفروض في `20260522121846_add_compound_indexes`: فهرس مركّب يبدأ بـ `storeId`، زائد فهرس مفرد على الـ FK.

`balanceAfter` لقطة مخزّنة عشان تدقّق أي حركة بدون إعادة جمع السجل من أوله. لما تنكتب أكتر من حركة بنفس الترانزاكشن، القيمة بتتراكم بالترتيب — كل حركة بتحمل الرصيد **بعدها هي**.

### ٣.٦ إضافة على `Store`

```prisma
model Store {
  // ... الحقول الحالية
  creditEntries CreditEntry[]
  paymentOps    DebtPaymentOperation[]
}
```

بدون العلاقتين العكسيتين الـ schema ما بتُصادَق أصلاً و`prisma generate` بيفشل.

### ٣.٧ الميجريشن

إضافية بالكامل، ملتزمة بالقاعدة المكتوبة في `docs/superpowers/plans/`: `CREATE TYPE` / `CREATE TABLE` / `ADD COLUMN` / `CREATE INDEX` فقط. صفر `UPDATE`، صفر `DROP`، صفر `SET NOT NULL`، صفر backfill.

```sql
CREATE TYPE "PaymentSource" AS ENUM ('CASH', 'CREDIT');
CREATE TYPE "CreditReason" AS ENUM
  ('OVERPAYMENT', 'OVERPAYMENT_REVERSED', 'APPLIED_TO_DEBT', 'APPLIED_REVERSED');

ALTER TABLE "customers"     ADD COLUMN "creditBalance" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "debt_payments" ADD COLUMN "source" "PaymentSource" NOT NULL DEFAULT 'CASH';
ALTER TABLE "debt_payments" ADD COLUMN "operationId" TEXT;

CREATE TABLE "debt_payment_operations" (...);
CREATE TABLE "credit_entries" (...);
-- الفهارس ثم المفاتيح الأجنبية بسياسات بند ٣.٤ و ٣.٥

ALTER TABLE "customers"
  ADD CONSTRAINT "customer_credit_non_negative"
  CHECK ("creditBalance" >= 0);
```

**نقطة انتباه على القيد الأخير.** `ADD CONSTRAINT` بياخد قفل `ACCESS EXCLUSIVE` وبيمسح `customers` كامل. حجم الجدول صغير فالمسح ثواني، وفي سابقة بنفس الريبو (`20260522114500` عمل نفس الشي على ثلاث جداول). بس تقنياً هذا خارج قاعدة "`ADD COLUMN` بس" — قرار واعٍ مش سهو، ومكتوب هون عشان يتراجَع.

الميجريشن تُولَّد بـ `prisma migrate dev --create-only` ثم **يُعاد كتابة جسمها** بتعليقات تشرح ليش كل جملة آمنة، مطابقة لأسلوب `20260525150000_add_customer_client_idempotency_key`. لا تُشحن مخرجات prisma الخام.

---

## ٤. الحساب وقاعدة الإشارة

```
totalRemaining = Σ (debts.remaining للزبون)      ← موجب دايماً، أو صفر
creditBalance  = عمود مخزَّن                       ← موجب دايماً، أو صفر
balance        = creditBalance − totalRemaining   ← موقَّع
```

| الحالة | `creditBalance` | `totalRemaining` | `balance` |
|---|---|---|---|
| عليه ١٠٠ | `0` | `100` | `-100` |
| سدّد بالضبط | `0` | `0` | `0` |
| عليه ١٠٠ ودفع ١٥٠ | `50` | `0` | `50` |
| رصيد ٥٠ وعليه ٨٠ (لسا ما تقاصّوا) | `50` | `80` | `-30` |

**السطر الأخير هو المفتاح:** حتى لما الرصيد والدين مسجلين منفصلين، الرقم اللي بتشوفه الواجهة صح. المقاصّة الداخلية توقيت، مش صحة.

### ٤.١ صيغة المبالغ على السلك

كل المبالغ نصوص من `Decimal.prototype.toString()` — **بدون عدد منازل مضمون**. `50` و `50.1` و `0` كلها مخرجات صحيحة.

هذي مش قاعدة جديدة، هي القاعدة القائمة: `Decimal.prototype.toJSON` هو نفسه `toString`، فكل عمود `Decimal` بيرجع اليوم بهالشكل (`invoice.total` بيطلع `"50"` مش `"50.00"`)، والمجاميع المحسوبة بتستعمل `.toString()` صراحةً في `customer.service.ts:279`. الـ handoff بيقبل هالصيغة نصاً: «Money values may be JSON numbers or decimal strings».

**الخلاصة العملية:** `creditBalance` بيركب مجاناً على قراءات الزبون وبيطلع بنفس صيغة إخوته بالضبط، و`balance` المحسوب لازم يمرق على `.toString()` كمان — **ممنوع** `.toFixed(2)` على واحد و `.toString()` على التاني.

كل الحساب بـ `Prisma.Decimal` من طرف لطرف. لا `Number`، لا `parseFloat`.

---

## ٥. مسار الدفع — `POST /api/debts/customer/:customerId/pay`

المسار **موجود أصلاً** بنفس الـ path والـ method والـ status (`201`). ما بينغيّر ولا واحد فيهم. اللي بينغيّر هو المنطق جوّا.

### ٥.١ الخطوات

نفس إعدادات الترانزاكشن المستعملة في كل مسارات المال: `ReadCommitted`، `maxWait: 10_000`، `timeout: 30_000`.

```
داخل الترانزاكشن:

١. قفل صف الزبون — أول جملة، بلا شرط:
   SELECT id, "creditBalance" FROM customers
   WHERE id = $customerId AND "storeId" = $sid AND "isDeleted" = false
   FOR UPDATE
   → غير موجود ⇒ 404 'العميل غير موجود'

٢. إذا وُصل clientOperationId:
   ابحث عن debt_payment_operations بنفس (storeId, clientOperationId)
   → وُجدت ⇒ أعِد بناء الرد من صفوفها وارجعه فوراً. صفر كتابة.

٣. قفل ديون الزبون غير المسددة:
   SELECT ... FROM debts
   WHERE "customerId" = $ ... AND "isPaid" = false
   ORDER BY date ASC
   FOR UPDATE

٤. وزّع الكاش المدفوع على الديون من الأقدم للأحدث      ← source: CASH

٥. إذا ضلّت ديون مفتوحة وعند الزبون رصيد سابق:
   صفّي الرصيد عليها من الأقدم للأحدث                  ← source: CREDIT
   لكل تطبيق: CreditEntry { delta: −x, reason: APPLIED_TO_DEBT }

٦. الفائض من الكاش (إن وُجد):
   creditBalance += excess
   CreditEntry { delta: +excess, reason: OVERPAYMENT }

٧. أنشئ صف العملية واربط فيه كل الدفعات وحركات الرصيد

بعد ما ترجع الترانزاكشن (خارجها):

٨. await invalidateStoreData(sid)
```

**الخطوة ٨ خارج الترانزاكشن عمداً.** تبطيل الكاش قبل الـ COMMIT بيسمح لـ `GET /sync/init` متزامن إنه يعبّي الكاش من لقطة ما قبل الـ commit ويثبّت نفس الرصيد القديم لثلاثين ثانية — وهو بالضبط اللي بند ١١.٤ موجود عشان يمنعه. وإذا رجعت الترانزاكشن للوراء، بنكون بطّلنا الكاش ببلاش. كل مسارات المال في الريبو بتعمل التبطيل بعد الترانزاكشن، وهذا مقصود.

**ليش الكاش قبل الرصيد:** الزبون بيسلّم فلوس بإيده. الصح محاسبياً إنك تسدّد من فلوسه الجديدة أولاً وما تلمس الرصيد المحفوظ إلا للي بقي مكشوف. الترتيب المعكوس بيعطي نفس الرقم الصافي بس بيولّد حركات رصيد بدون داعي.

### ٥.٢ الحارسان المحذوفان

| الحارس المحذوف | السلوك الجديد |
|---|---|
| `'لا توجد ديون غير مسددة لهذا العميل'` | كامل المبلغ يصير رصيد |
| `'المبلغ المدفوع (...) يتجاوز إجمالي الديون المتبقية (...)'` | الفائض يصير رصيد |

### ٥.٣ التحقق الباقي

| الحالة | النتيجة |
|---|---|
| `amount <= 0` | **400** (`@IsPositive` موجود على الـ DTO) |
| أكثر من منزلتين عشريتين | **400** |
| الزبون غير موجود أو محذوف | **404** |
| `clientOperationId` أطول من ٢٠٠ حرف | **400** |

### ٥.٤ فصل الـ DTO

`PayDebtDto` مشترك اليوم بين هذا المسار و `POST /debts/:id/pay` (`debt.controller.ts` السطر ٩٨ والسطر ١٢٩). إضافة `clientOperationId` عليه بتعلن ضمانة idempotency على مسار **ما بينفّذها**.

الحل: `dto/pay-customer-debt.dto.ts` جديد يرث الحقول ويضيف:

```ts
@ApiPropertyOptional({ description: 'مُعرّف العملية من الجهاز — لمنع تكرار الدفعة عند إعادة الإرسال' })
@IsOptional() @IsString() @MaxLength(200)
clientOperationId?: string;
```

`PayDebtDto` بيضل كما هو حرفياً لمسار الدين المفرد.

### ٥.٥ وصف Swagger

الوصف الحالي على `amount` بيقول "ولا يتجاوز المبلغ المتبقي" — صار كذب. يُعاد كتابته هو ووصفَي الـ `400` على المسار.

---

## ٦. الـ Idempotency

`@@unique([storeId, clientOperationId])` على صف العملية.

**لا نلتقط `P2002` محلياً.** `PrismaExceptionFilter` بيحوّله لـ `409` أصلاً، وهذا السلوك المتّبع في `customer.service.ts` و `invoice.service.ts`. سباق خاسر بيرجع `409` والجهاز بيعيد المحاولة فبيلاقي الصف موجود.

**الرد على الإعادة** يُعاد بناؤه من الصفوف المخزّنة، مش محفوظ كـ JSON:

- `affectedDebts` و `paymentApplied` و `creditApplied` و `excessToCredit` → من `operation.payments` و `operation.creditEntries`. هذي حقائق ثابتة عن العملية.
- `summary` و `debts` → **تُحسب من جديد**. الجهاز بيستعمل الرد ليحدّث حالته المحلية، فإرجاع ملخّص قديم بيرجّع الواجهة للوراء.

الحالة تبقى `201`. طابور الأوف‌لاين ما لازم يعامل الإعادة كفشل قابل للمحاولة.

**المفتاح هو المرجع الوحيد.** إذا وصل نفس `clientOperationId` بمبلغ مختلف، الرد هو نتيجة العملية الأصلية بلا أي كتابة — ما في مقارنة على `amount` ولا رفض. الجهاز مسؤول عن توليد مفتاح جديد لعملية جديدة.

---

## ٧. أكل الرصيد عند إنشاء فاتورة دين

داخل نفس ترانزاكشن `InvoiceService.create()`، بعد الخطوة ٤ (إنشاء الدين).

### ٧.١ الهيلبر

`credit.util.ts` بيصدّر دالة واحدة بتستقبل الزبون **مقفولاً مسبقاً** — ما بتقفله بنفسها (انظر ٧.٢):

```
applyCreditToDebt(tx, { sid, customerId, creditBalance, debtId, debtRemaining, invoiceId }):
  applied = Decimal.min(creditBalance, debtRemaining)
  إذا applied == 0 ⇒ لا شيء

  DebtPayment { amount: applied, source: CREDIT, debtId }
  debt.update    { paid:      { increment: applied },
                   remaining: { decrement: applied },
                   isPaid:    (debtRemaining − applied).isZero() }
  invoice.update { paid:      { increment: applied },
                   remaining: { decrement: applied } }        ← إذا invoiceId موجود
  customer.update { creditBalance: { decrement: applied } }
  CreditEntry { delta: −applied, reason: APPLIED_TO_DEBT, debtPaymentId }
```

**`increment`/`decrement` مش إسناد مطلق.** بوسطجرس بيحسب الطرفين في نفس جملة الـ `UPDATE`، فالقيد `paid + remaining = amount` بيشوف الصف النهائي بس. الإسناد المطلق (`paid: applied`) صحيح فقط على دين لسا انخلق بـ `paid = 0`؛ عند أي استدعاء تاني — بند ٥.١ خطوة ٥ حيث الدين لسا استلم كاش، أو بند ٨.٢ خطوة ٣ — بيمسح المدفوع السابق ويكسر القيد.

**تحديث الفاتورة إلزامي.** لو الدين اتحرّك والفاتورة ضلّت `paid = 0`، أول دفعة كاش لاحقة بتخلّي `paid + remaining ≠ total` والقيد بيرفضها. القيد بيطلع **500 غامض** مش 400 (`PrismaExceptionFilter` ما بيغطّي `23514`)، والدين بيصير غير قابل للسداد للأبد.

**`isPaid` تُكتب صراحةً.** لو الرصيد غطّى الدين كاملاً وتُركت على الافتراضي `false`، بيصير عندك دين بـ `remaining = 0` و `isPaid = false` — وهذا بيسمّم `payForCustomer` (بيولّد دفعات بمبلغ صفر) وقوائم الديون المفتوحة.

### ٧.٢ ترتيب القفل — إلزامي وشامل

**المتجر ← الزبون ← الديون ← الفواتير.**

`InvoiceService.create` بياخد قفل صف المتجر **صراحة، كأول جملة** في الترانزاكشن — قبل قفل الزبون. صفوف الفاتورة والدين فيه فعلاً **جديدة وغير مرئية** لأي ترانزاكشن تانية، بس `store.update({ lastInvoiceNumber })` بيصير في خطوة لاحقة (بعد قفل الزبون في الكود القديم)، مش قبلها — يعني الادّعاء إن `create` كانت "ماسكة المتجر أصلاً" وقت ما بتاخد قفل الزبون كان غلط، والترتيب الفعلي كان زبون ← منتجات ← متجر. السبب اللي بيفرض المتجر أولاً هو `sync/push`: بياخد قفل صف المتجر أول شي (`tx.store.update({ lastInvoiceNumber })`)، وبعدين بيلمس صفوف الزبون عبر الـ FK inserts (`tx.invoice.createMany` / `tx.debt.createMany` مع `customerId`)، وكل FK insert بياخد `FOR KEY SHARE` على صف الزبون المُشار إليه — وهذا بيتعارض مع `FOR UPDATE`. لو `create` قفلت الزبون قبل المتجر كانت بتتعاكس مع `push` وتعمل دورة deadlock (`40P01`, غير مغطّى بـ`PrismaExceptionFilter`، فبيطلع 500).

**`update` و `remove` مختلفين تماماً — صفوفهم موجودة أصلاً.** `InvoiceService.update` بياخد قفل صف الفاتورة عند `tx.invoice.update` (`invoice.service.ts:515`) قبل ما يوصل لقفل الدين (`:568`)، وهذا عكس ترتيب `payForCustomer` (الديون `:342`–`:347` ثم الفاتورة `:398`). هالانعكاس موجود في الكود اليوم.

**القاعدة الملزِمة:** أي ترانزاكشن بتلمس ديون زبون أو فواتيره لازم تاخد قفل صف الزبون `FOR UPDATE` **كأول جملة فيها**، قبل أي `tx.invoice.update` أو `tx.product.updateMany`، و**بلا شرط** — حتى لو الفاتورة ما أكلت رصيد وحتى لو ما في رصيد يُرجَّع. القفل على صف الزبون هو اللي بيسلسل المسارين وبيخلّي انعكاس (ديون/فواتير) غير مؤذي.

بدون هالقاعدة: `PATCH /invoices/:id` ماسك الفاتورة ومستني الزبون، و`POST /debts/customer/:id/pay` ماسك الزبون ومستني الفاتورة → **deadlock**. بوسطجرس بيقتل واحد بـ `40P01`، و`PrismaExceptionFilter` ما بيغطّيه، فبيطلع **500**.

**لما الترانزاكشن تلمس زبونين** (بند ٨.٢، نقل فاتورة من زبون لزبون): القفلين ياخدوا **بترتيب `id` تصاعدي** عشان ترانزاكشنتين معكوستين ما يتقافلوا.

### ٧.٣ الفواتير اللي بتأكل رصيد

الهيلبر بينربط على `needsCustomer` في `invoice.service.ts:248`، يعني **`DEBT` و `PARTIAL` الاتنين**.

على فاتورة `PARTIAL` هذا مقصود: الرصيد بينزّل الجزء المؤجَّل بالضبط زي ما دفعة كاش لاحقة كانت بتعمل. الحالة الناتجة (`paymentMethod = PARTIAL`, `paid = total`, `remaining = 0`) **مش جديدة** — هي نفس الحالة اللي بتوصلها أي فاتورة جزئية لما الزبون يسدّد باقي دينه اليوم عبر `DebtService.pay`.

التحقق `paidAmount.gte(total)` عند الإنشاء بيفحص **`dto.paid` المُرسَل**، وبيشتغل قبل أي تطبيق رصيد. تطبيق الرصيد بيصير بعده وما بينعاد التحقق عليه. نفس الشي في `update`.

`CASH` و `ONLINE` ما بيخلقوا دين أصلاً (`customerId` بينفرض `null`)، فما بيأكلوا رصيد — والزبون بيضل محتفظ فيه.

### ٧.٤ المسارات اللي **ما** بتأكل رصيد في v1

| المسار | السبب |
|---|---|
| `POST /api/sync/push` | خارج النطاق — انظر بند ١٠ |
| `CustomerService.create` مع `initialDebt` | رصيد افتتاحي عند التأسيس، بحكم التعريف ما قبله رصيد |

---

## ٨. العكس — أخطر جزء في المواصفة

الـ handoff ساكت عن هذا القسم بالكامل. بدونه، الفلوس بتضيع بصمت في ثلاث مسارات موجودة اليوم.

**كل مسار في هذا البند بيبدأ بقفل صف الزبون `FOR UPDATE` كأول جملة في ترانزاكشنه** — انظر ٧.٢.

### ٨.١ المدفوع كاش — الرقم الحاكم لكل الحرّاس

بمجرد ما يصير في دفعات `source: CREDIT`، `debt.paid` بطّل يعني "المبلغ غير القابل للاسترجاع". الرقم الصحيح:

```
cashPaid = debt.paid − Σ (payments حيث source = CREDIT).amount
```

الحرّاس الأربعة كلهم بيقارنوا بـ `cashPaid` مش بـ `debt.paid`:

| الموضع | متى بيشتغل | التعديل |
|---|---|---|
| `invoice.service.ts:434` | **قبل الترانزاكشن** | `payments.length > 0` ← يفلتر على `source: CASH` |
| `invoice.service.ts:444` | **قبل الترانزاكشن** | يقارن `remaining` بـ `cashPaid` |
| `invoice.service.ts:462` | **قبل الترانزاكشن** | `payments.length > 0` ← يفلتر على `source: CASH` |
| `invoice.service.ts:583` | جوّا الترانزاكشن بعد `FOR UPDATE` | يقارن بـ `cashPaid` من الصفوف الحيّة |

**الثلاثة الأولى بتقرأ من `include` بأول `update()` (`:287`)، وبتشتغل قبل ما تُفتح الترانزاكشن (`:470`).** يعني أي إرجاع رصيد جوّا الترانزاكشن **ما بتنوصلها أصلاً** — الطلب بيرجع `400` قبل ما الترانزاكشن تبدأ. عشان هيك الـ `include` لازم يجيب `payments: { select: { id, amount, source } }` والحرّاس تُصلَّح في مكانها، مش تُنقل.

نفس المنطق على حارس الحذف في `invoice.service.ts:826`.

### ٨.٢ حذف فاتورة — `DELETE /api/invoices/:id`

الحارس الحالي بيرفض بس لما الدين **غير مسدد ومعه دفعات**. لما الرصيد يغطّي الدين كاملاً بتصير `isPaid = true`، فالحارس بيمرّق والفاتورة بتنحذف والدين ودفعته بينمحوا بالـ CASCADE — وفلوس الزبون بتختفي بلا خطأ ولا أثر.

| الحالة | السلوك |
|---|---|
| على الدين دفعات `source: CASH` | يبقى الرفض الحالي بلا تغيير |
| على الدين دفعات `source: CREDIT` فقط | يُسمح — والرصيد يرجع كاملاً |

قبل الحذف، لكل دفعة `CREDIT`:

```
creditBalance += payment.amount
CreditEntry { delta: +payment.amount, reason: APPLIED_REVERSED,
              notes: 'إرجاع رصيد — حذف الفاتورة رقم N' }
```

### ٨.٣ تعديل فاتورة — `PATCH /api/invoices/:id`

**الحل: أرجِع ثم أعِد التطبيق**، كله جوّا ترانزاكشن التعديل:

```
٠. قفل صف الزبون FOR UPDATE (وصف الزبون الجديد كمان إذا تغيّر — بترتيب id تصاعدي)
١. أرجِع كل الرصيد المستهلَك على هذي الفاتورة  ← APPLIED_REVERSED
٢. أعِد حساب الأصناف والخصم والدين كما هو اليوم بالضبط
٣. طبّق الرصيد من جديد على المتبقي الجديد (هيلبر ٧.١)
```

الحرّاس اللي بتشتغل قبل الترانزاكشن مصلَّحة في ٨.١، فالطلب بيوصل لخطوة ١ أصلاً.

**تغيير الزبون.** `PATCH` بيقبل `dto.customerId` وبينقل الدين لزبون تاني (`invoice.service.ts:588`). القاعدة:

- الإرجاع (خطوة ١) بيروح لـ **الزبون الأصلي** — هو اللي فلوسه موّلت الفاتورة.
- التطبيق (خطوة ٣) بياخد من **الزبون الجديد**.

العكس بيحوّل فلوس زبون لحساب زبون تاني بلا أثر محاسبي — ممنوع.

### ٨.٤ حذف دفعة — `DELETE /api/debts/:id/payments/:paymentId`

| الدفعة | السلوك |
|---|---|
| `source: CREDIT` | يُسمح — `creditBalance += amount`، حركة `APPLIED_REVERSED`، والدين يرجع مكشوف |
| `operationId = NULL` | السلوك الحالي حرفياً — الدفعة ما إلها عملية فما ولّدت فائضاً |
| `source: CASH` وعمليتها ما ولّدت فائضاً | السلوك الحالي حرفياً |
| `source: CASH`، فائض العملية **لسا موجود** | يُسمح — يُسحب الفائض مرة واحدة ويرجع الدين |
| `source: CASH`، فائض العملية **انصرف** | **400** |

الرسالة: `'لا يمكن حذف هذه الدفعة — الرصيد الناتج عنها تم استخدامه'`

**الفائض ملك العملية، مش ملك الدفعة.** العملية الواحدة بتولّد N دفعات كاش وحركة `OVERPAYMENT` واحدة. الخوارزمية:

```
إذا payment.operationId == NULL ⇒ السلوك الحالي، خلاص.

op       = payment.operation
overpay  = CreditEntry حيث operationId = op.id AND reason = OVERPAYMENT
إذا ما في overpay ⇒ السلوك الحالي، خلاص.

already  = CreditEntry حيث operationId = op.id AND reason = OVERPAYMENT_REVERSED
إذا already موجودة ⇒ الفائض انسحب من قبل، أكمل الحذف عادي.

spentSince = CreditEntry حيث customerId = op.customerId
                            AND reason = APPLIED_TO_DEBT
                            AND date >= overpay.date
إذا spentSince موجودة ⇒ 400
وإلا:
  creditBalance −= overpay.delta
  CreditEntry { delta: −overpay.delta, reason: OVERPAYMENT_REVERSED, operationId: op.id }
  أكمل الحذف
```

فحص `already` هو اللي بيخلي حذف الدفعة التانية والتالتة من نفس العملية **ما يسحب نفس الفائض مرتين**. بدونه، حذف دفعتين من عملية فائضها ٥٠ بيسحب ١٠٠.

**تصحيح على نسخة أولى من هالمواصفة:** الشرط كان مكتوب `creditBalance < overpay.delta ⇒ 400`، وهذا **غلط**. رصيد الزبون رقم واحد مش مربوط بعملية معيّنة، فأي عملية لاحقة بتغطّي فائض عملية سابقة انصرف. مثال: فائض op1 = ٥٠، انصرف على فاتورة، الرصيد صفر؛ بعدين op2 بتعطي +٦٠. حذف دفعة op1 بيلاقي `60 < 50` غلط، فبيسحب الـ٥٠ **من فلوس op2** — والزبون بيخسر ٥٠ إله. الشرط الصحيح هو `spentSince` أعلاه: لو أي رصيد انصرف بعد ما ظهر الفائض، ما عاد فينا نثبت إنه لسا موجود، فبنرفض. أضيق من اللازم أحياناً، وهذا مقصود — الرفض بيتصلّح بحذف يدوي، والسحب الغلط بيضيّع فلوس زبون.

هذا المسار **`ADMIN` فقط** بينما مسار الدفع `ADMIN` و `CASHIER`. يعني الكاشير بيقدر يولّد رصيد وما بيقدر يفكّه — وهذا مقصود ومطابق للتباين الموجود اليوم.

### ٨.٥ أرشفة زبون — `DELETE /api/customers/:id`

الحارس الحالي بيرفض الأرشفة لما يكون على الزبون ديون غير مسددة، وما بيعرف إشي عن الرصيد. أرشفة زبون معه رصيد بتخفي صفّه من `/customers` ومن `/sync/init` (الاتنين بيفلتروا `isDeleted: false`) والالتزام بيضل قائم.

**التعديل:** يُرفض كمان لما `creditBalance > 0`، برسالة عربية. المخرج الوحيد هو حذف الدفعة اللي ولّدت الرصيد (٨.٤) أو صرفه على فاتورة. (الرسالة الحالية `'Cannot delete customer with outstanding unpaid debts.'` إنجليزية — هذي مخالفة للعُرف مش العُرف نفسه. الجديدة بالعربي.)

**إلغاء الأرشفة تلقائياً عند الإرجاع.** الحارس لحاله ما بيكفي: زبون رصيده صفر بينأرشف بشكل سليم، وبعدين حذف فاتورة أو دفعة بيرجّعله رصيد — فبيصير معه فلوس وهو مخفي عن `/customers` و`/sync/init`، وهي بالضبط الحالة اللي الحارس موجود عشان يمنعها. عشان هيك `grantCredit` بيلغي الأرشفة (`isDeleted: false`, `deletedAt: null`) لما يعطي رصيد لزبون مؤرشف. القرار محطوط جوّا `grantCredit` مش عند المستدعي، عشان كل مسار إرجاع حالي أو مستقبلي يرثه. فلوس المحل مديون فيها لازم تضل ظاهرة.

**أثر جانبي مقصود:** حذف فاتورة قديمة لترتيب البيانات ممكن يرجّع زبون مؤرشف للقوائم بدون ما حدا يطلب ذلك صراحة. صحيح بالنسبة للقاعدة، بس مفاجئ عند الكاشير — مذكور هون عشان يكون متوقَّع.

---

## ٩. التقارير

### ٩.١ `getDailyProfit` — بدون تغيير

`reports.service.ts` بيحسب من `invoice_items` و `invoices.discount` وما بيقرأ الديون ولا الرصيد أصلاً، فحركات الرصيد **بحد ذاتها** ما بتحرّكه. `test/report-timezone.e2e-spec.ts` بيضل أخضر وهو دليل إن ما تسرّبنا.

هذا **ما بيعني** إن الرقم ثابت في كل سيناريوهات هذي المواصفة: حذف فاتورة أو تعديل أصنافها بيغيّر `invoice_items`، فالربح بيتغيّر — تماماً زي اليوم وبنفس المقدار.

**قاعدة صارمة: صرف الرصيد ممنوع يُمثَّل كـ `invoice.discount`.** هذا بيشطب إيراداً حقيقياً يوم الصرف ويضخّم الخسارة.

### ٩.٢ `GET /api/invoices/daily-sales` — حقلان جديدان

الاتنين **صافيان**، محسوبان على مجموعات أسباب صريحة — عشان هيك انقسم `CreditReason` لأربع قيم اتجاهية في ٣.٥:

| الحقل | التجميعة | المعنى |
|---|---|---|
| `totalCreditReceived` | `Σ delta` حيث `reason ∈ {OVERPAYMENT, OVERPAYMENT_REVERSED}` | كاش دخل الدرج اليوم وصار رصيداً — نقد، مش إيراد |
| `totalCreditApplied` | `−Σ delta` حيث `reason ∈ {APPLIED_TO_DEBT, APPLIED_REVERSED}` | رصيد انصرف اليوم على ديون — إيراد، مش نقد |

دفعة ١٥٠ على دين ١٠٠ اتلغت نفس اليوم → `OVERPAYMENT +50` و `OVERPAYMENT_REVERSED −50` → `totalCreditReceived = 0`. صح، لأن الفلوس طلعت من الدرج.

يُحسبان على **ساعة المحل** (`dayRangeInZone` مع `env.STORE_TIMEZONE`)، مطابقة للإصلاح المعتمد في `fix/report-timezone`.

الحقول القديمة ما بتتلمس.

### ٩.٣ `GET /api/debts/summary` — حقلان جديدان

| الحقل | المعنى |
|---|---|
| `totalCredit` | `Σ creditBalance` لكل زبائن المحل |
| `netRemaining` | `Σ` على كل زبون من `max(0, دينه − رصيده)` |

**المقاصّة لكل زبون على حدة، مش على مستوى المحل.** رصيد زبون ما بيسدّد دين زبون تاني، وطرح المجاميع الكلية بيعطي رقم مضلّل.

**الزبائن المؤرشفون (`isDeleted = true`) داخلون في الحسبة.** الحقل القائم `totalRemaining` بيجمع `debts` بدون أي فلترة على الزبون، فهو أصلاً بيعدّ ديون المؤرشفين؛ فلترة الجديد بشكل مختلف بتخلّي الرقمين ما يتصالحوا. (وأصلاً ٨.٥ بيمنع أرشفة زبون معه رصيد.)

الحقول القديمة (`totalRemaining`, `unpaidRemaining`, ...) ما بتتغيّر ولا بتتلمس.

### ٩.٤ تقرير الـ PDF الليلي

`backup.service.ts` بيبني `grandTotal` و `largestDebt` وقائمة "الأولوية القصوى" و أعمدة الأعمار الأربعة كلها من الدين الخام. زبون رصيده يغطّي دينه بيطلع مطلوب منه فلوس.

**التعديل:** المقاصّة لكل زبون قبل الترتيب والعدّ. زبون صافيه صفر أو أقل بينشال من القائمة ومن `debtorCount` بالكامل — مبلغه وعمره الاتنين.

**تبسيط مقصود:** للزبون المغطّى **جزئياً**، بينتعدّل المبلغ بس. `oldestDebtDays` بيضل محسوباً من ديونه غير المسددة الخام. المقاصّة النظرية ما بتحدّد أي دين بالضبط "انسدّ"، وربط الرصيد بأقدم دين لغرض العرض بيغيّر دلو الأعمار بدون أي حركة حقيقية في القيد. الرقم ده تنبيه أولوية، مش رقم محاسبي.

---

## ١٠. المزامنة الأوف‌لاين — خارج النطاق، وليش

`POST /api/sync/push` بيتجاوز `InvoiceService` و `DebtService` بالكامل: `createMany` بمعرّفات من الجهاز، وبياخد `paid`/`remaining`/`isPaid` المرسلة من الجهاز كما هي. يعني **بيعة دين أوف‌لاين ما رح تأكل من الرصيد**.

الأسباب الأربعة لتأجيله:

1. **صرف مزدوج.** جهازان أوف‌لاين شايفان نفس الرصيد، كلاهما بيصرفه. الحل بيتطلب إن السيرفر يعيد حساب أرقام الجهاز، وهذا بيغيّر عقد الـ sync.
2. **قفل ناقص.** الـ push كله تحت `pg_advisory_xact_lock` لكل محل، بس دفعات REST مش تحته. push ودفعة أونلاين بنفس اللحظة بيقدروا يصرفوا نفس الرصيد.
3. **الـ DTO ما بيسع الحالة.** `SyncDebtPaymentDto.debtId` مطلوب وإجباري، فدفعة على مستوى الزبون ما بتنكتب أصلاً بالحمولة الحالية.
4. **مفتاحان متنافسان.** نفس الدفعة ممكن تمرق عبر `clientOperationId` أو عبر UUID من الجهاز. ولا واحد بيشوف مفتاح التاني.

**النتيجة العملية: الفلوس ما بتضيع.** الرصيد بيضل محفوظاً والرقم الموقَّع اللي بتعرضه الواجهة صحيح دايماً (`50 − 80 = −30`)، لأنه محسوب من الطرفين مش من صف واحد. **ما في مهمة مقاصّة دورية ولا job في الخلفية** — المقاصّة بتصير حصراً عند أول دفعة (٥.١ خطوة ٥) أو أول فاتورة أونلاين (٧) بعدها.

`test/sync.e2e-spec.ts` بيتأكد من `400` عند الدفع الزائد في هذا المسار. **هذا الاختبار يبقى أخضر عمداً** وهو دليل إن الحد ما انكسر.

---

## ١١. عقد الاستجابة

### ١١.١ ثلاث فروقات بين الـ handoff والكود الحالي

| الـ handoff | الكود الحالي | الحكم |
|---|---|---|
| `summary.totalDebt` | `payForCustomer` بيرجّع `totalAmount` بنفس المعنى، و`totalDebts` (**عدد** الديون) | `totalDebt` **مش اسم جديد على المشروع** — `CustomerService.getDebtSummary` بيرجّعه اليوم بنفس المعنى بالضبط. بينضاف لـ `payForCustomer` كـ alias لـ `totalAmount` |
| `debts: []` | `affectedDebts: [...]` | اسمان مختلفان لشيئين مختلفين. `debts` يُضاف، و`affectedDebts` يبقى |
| يعرض `summary` و `debts` فقط | يرجّع كمان `customer` و `paymentApplied` | مثال الـ handoff مش عقد كامل. كل الموجود يبقى |

**تنبيه — المسارَان بيرجّعا مجموعات حقول مختلفة اليوم، مش نفس الأربعة بأسماء مختلفة:**

| | `getDebtSummary` | `payForCustomer` / `findByCustomer` |
|---|---|---|
| مجموع مبالغ الديون | `totalDebt` | `totalAmount` |
| عدد الديون | `totalDebts` | `totalDebts` |
| مدفوع / متبقٍ / غير مسدد | `totalPaid`, `totalRemaining`, `unpaidCount` | نفسها |

بعد التعديل الاتنين بيحملوا `totalDebt` و `totalAmount` و `creditBalance` و `balance` — يعني بيتقاربوا بدون ما ينكسر أي اسم قائم.

### ١١.٢ الرد الكامل

```jsonc
{
  "customer": { "id": "…", "name": "…", "phone": "…" },   // موجود
  "paymentApplied": "150",                                 // موجود — الكاش المستلَم
  "affectedDebts": [                                       // موجود
    { "debtId": "…", "amountPaid": "100", "creditPaid": "0", "isPaid": true }
  ],
  "creditApplied":  "0",     // جديد — كم انصرف من رصيد سابق
  "excessToCredit": "50",    // جديد — كم راح للرصيد
  "debts": [ /* كل ديون العميل بعد العملية — المسدَّدة والمفتوحة */ ],   // جديد
  "summary": {
    "totalDebts": 3,          // موجود — عدد
    "unpaidCount": 0,         // موجود
    "totalAmount": "100",     // موجود
    "totalPaid": "100",       // موجود
    "totalRemaining": "0",    // موجود
    "totalDebt": "100",       // جديد هنا — alias لـ totalAmount
    "creditBalance": "50",    // جديد
    "balance": "50"           // جديد = creditBalance − totalRemaining
  }
}
```

**`affectedDebts[].amountPaid` = الجزء المدفوع كاش فقط.** هذا معناه اليوم بالضبط (كل الدفعات اليوم كاش)، فما بينكسر. الجزء الممول من الرصيد بيطلع في حقل جديد `creditPaid` على نفس الصف.

**تنبيه:** `Σ amountPaid === paymentApplied` مش صحيحة لما في فائض. `paymentApplied` هو الكاش **المُسلَّم** من الزبون، بينما `amountPaid` هو الجزء اللي **انصرف فعلاً على الديون**. الفرق بينهم هو بالضبط `excessToCredit` — الفائض اللي راح لرصيد الزبون بدل ما ينصرف على دين. العلاقة الصحيحة اللي بتنمسك دايماً هي:

```
Σ affectedDebts[].amountPaid + excessToCredit === paymentApplied
Σ affectedDebts[].creditPaid                  === creditApplied
```

مثال: دين ١٠٠ ودفعة ١٥٠ → `paymentApplied: "150"`، `Σ amountPaid = 100`، `excessToCredit: "50"` (١٠٠ + ٥٠ = ١٥٠).

مثال معيار القبول ١١ (رصيد ٥٠، دين ٨٠، دفع ٣٠ كاش):
```jsonc
{ "debtId": "…", "amountPaid": "30", "creditPaid": "50", "isPaid": true }
```

صيغة المبالغ حسب بند ٤.١ — `.toString()`، بدون عدد منازل مضمون، مطابقة لكل مبلغ في المشروع.

### ١١.٣ مسارات القراءة

| المسار | الإضافة |
|---|---|
| `GET /api/customers`، `/customers/:id` | `creditBalance` بيركب مجاناً (قراءة الصف كامل) + `balance` محسوب |
| `GET /api/customers/:id/debt-summary` | ⚠️ **الوحيد** بـ `select {id,name,phone}` ضيّق — بينسى العمود بصمت لو ما انضاف يدوياً |
| `GET /api/debts/customer/:customerId` | `creditBalance` + `balance` بنفس شكل بند ١١.٢ |
| `GET /api/debts/summary` | `totalCredit` + `netRemaining` |
| `GET /api/invoices/daily-sales` | `totalCreditReceived` + `totalCreditApplied` |
| `GET /api/sync/init` | `creditBalance` بيركب مجاناً ضمن صفوف الزبائن |

`balance` على قائمة الزبائن بده مجموع ديون لكل زبون. يُنفَّذ بـ **`groupBy` واحد** على `debts` مفلتَر بمعرّفات الصفحة (الفهرس `[storeId, customerId, isPaid]` بيغطّيه)، مش استعلام لكل صف.

### ١١.٤ الكاش

مسارات الديون بتستعمل `void this.cacheInvalidator.invalidateSyncInit(sid)` — إطلاق ونسيان، و`sync:init` مخزّن ٣٠ ثانية.

**التعديل:** المسارات الخمسة اللي بتحرّك الرصيد — ٥.١، ٧، ٨.٢، ٨.٣، ٨.٤ — بتعمل `await invalidateStoreData(sid)` **بعد ما ترجع الترانزاكشن** وقبل ما ترد. ٣٠ ثانية مقبولة لقائمة منتجات، غير مقبولة لرصيد الكاشير بيقرر عليه كم فلوس ياخد.

هذا **ما بيمنع** الصرف المزدوج — اللي بيمنعه هو قفل صف الزبون داخل الترانزاكشن. تصليح الكاش بس بيمنع الواجهة تكذب.

---

## ١٢. ملاحظات لمطور الواجهة

1. `balance = creditBalance − totalRemaining`. سالب = عليه دين. موجب = المحل مدين له.
2. **ترتيب النشر إلزامي: باك‌إند أولاً.** الـ `ValidationPipe` مضبوط على `forbidNonWhitelisted: true`، فأي واجهة بتبعت `clientOperationId` قبل نزول الباك‌إند بتاخد `400 property clientOperationId should not exist` — مش مسار متدهور، بل توقّف كامل لزر الدفع.
3. `POST /debts/:id/pay` (الدين المفرد) **ما بيقبل دفع زائد** وما بيدعم `clientOperationId`. خارج النطاق عمداً.
4. بيعة دين أوف‌لاين ما بتأكل رصيداً وقت الرفع — بتتقاصّ بأول حركة أونلاين. الرقم الموقَّع صحيح بكل الأحوال.
5. حقل `debts` في رد الدفع بيرجّع **كل ديون العميل** بعد العملية — المسدَّدة والمفتوحة — بنفس شكل ومحتوى `GET /debts/customer/:id`. مش المفتوحة بس. (مثال الـ handoff بيعرضه فاضي لأن الزبون في المثال ما إله أي دين أصلاً، مش لأن المسدَّدة بتنشال.)
6. `summary.totalDebts` عدد. `summary.totalDebt` مبلغ. الاسمان متشابهان عمداً لمطابقة الـ handoff — انتبهوا.
7. `affectedDebts[].amountPaid` هو الكاش فقط. الرصيد المستهلَك على نفس الدين في `creditPaid`.
8. كل المبالغ نصوص `Decimal.toString()` بدون عدد منازل مضمون — `"50"` مش `"50.00"`. نفس صيغة كل مبلغ في المشروع اليوم.

---

## ١٣. خارج النطاق (YAGNI)

- استرداد الرصيد كاش للزبون.
- دفع بالرصيد من شاشة الكاشير على فاتورة كاش.
- دفع زائد على `POST /debts/:id/pay`.
- تسوية يدوية للرصيد من المدير (± مبلغ بسبب مكتوب).
- endpoint مستقل لإضافة دين لزبون موجود (الالتفاف الحالي بمنتج "الدين الحالي" بيضل شغّال).
- أكل الرصيد في مسار `sync/push`.
- انتقال الرصيد بين المحلات.
- تنبيه أو إشعار عند تكوّن رصيد.

---

## ١٤. معايير القبول

### توافق خلفي

1. دفعة تساوي الدين بالضبط → نفس السلوك الحالي حرفياً، `creditBalance = 0`.
2. زبون أُنشئ قبل الميجريشن → `creditBalance = 0` و `balance = −totalRemaining`.
3. دفعة قديمة → `source = 'CASH'` و `operationId = NULL`، وكل الحقول القديمة في كل الردود بنفس أسمائها وأنواعها وقيمها.
4. `POST /debts/:id/pay` بمبلغ يتجاوز المتبقي → **400** كما اليوم.
5. `POST /sync/push` بدفعة زائدة → **400** كما اليوم.
6. طلب دفع بدون `clientOperationId` → يعمل عادي، وصف العملية يُنشأ بمفتاح `NULL`.
7. حذف دفعة `operationId = NULL` → السلوك الحالي حرفياً، والرصيد ما بينلمس.

### وظائف جديدة

8. دين ١٠٠، دفع ١٥٠ → الدين مسدَّد، `creditBalance = 50`، `balance = 50`.
9. زبون بلا ديون دفع ١٠٠ → `creditBalance = 100`، لا دفعات ولا أخطاء.
10. زبون رصيده ٥٠، فاتورة دين ٨٠ أونلاين → `remaining = 30`، `creditBalance = 0`، دفعة `source: CREDIT` بمبلغ ٥٠، والفاتورة `paid = 50` و `remaining = 30`.
11. زبون رصيده ١٠٠، فاتورة دين ١٠٠ → الدين `isPaid = true` صراحةً و `remaining = 0`.
12. زبون رصيده ٥٠ وعليه ٨٠، دفع ٣٠ كاش → الدين صفر، الرصيد صفر، `balance = 0`، والصف `{ amountPaid: "30", creditPaid: "50", isPaid: true }`.
13. فاتورة `PARTIAL` مجموعها ١٠٠ مدفوع منها ٤٠، والزبون رصيده ١٠٠ → `remaining = 0`، `paid = 100`، `creditBalance = 40`، بلا خطأ.
14. حذف فاتورة أكلت رصيداً → `creditBalance` رجع كامل، وحركة `APPLIED_REVERSED` مسجّلة.
15. تعديل فاتورة ١٠٠ مغطّاة برصيد ١٠٠ إلى ٦٠ → **مقبول** (الحارس قبل الترانزاكشن ما بيرفض)، والرصيد النهائي ٤٠.
16. تعديل فاتورة أكلت رصيد الزبون أ ونقلها للزبون ب → الرصيد رجع لـ **أ**، والجديد انأكل من **ب**، وحركتان مسجّلتان على الزبونين الصح.
17. حذف دفعة `source: CREDIT` → الرصيد رجع، الدين رجع مكشوف، حركة `APPLIED_REVERSED`.
18. حذف دفعة كاش ولّدت فائضاً انصرف → **400** بالرسالة العربية، **مش 500**.
19. عملية واحدة على دينين (٦٠ و ٤٠) بدفع ١٥٠ → فائض ٥٠. حذف الدفعة الأولى يسحب ٥٠ مرة واحدة؛ حذف الدفعة الثانية بعدها **ما بيسحب إشي** والرصيد بيضل صفر.
20. أرشفة زبون معه رصيد → **400** برسالة عربية.

### الـ Idempotency والتزامن

21. نفس `clientOperationId` مرتين → الفلوس تُطبَّق مرة واحدة، الرد `201`، و`affectedDebts` مطابق للأصل.
22. نفس المفتاح بمبلغ مختلف → نتيجة العملية الأصلية، بلا كتابة وبلا خطأ.
23. طلبان متزامنان بنفس `clientOperationId` لنفس الزبون → **الاتنين `201`**، والرصيد يتحرّك مرة واحدة. (المعيار كان مكتوب "واحد ٢٠١ وواحد ٤٠٩". التنفيذ طلع أنظف من المتوقَّع: بما إن قفل صف الزبون هو أول جملة والبحث عن العملية تانيها، الطلب التاني بيستنى على القفل وبعدين بيقرا العملية المكتوبة فبيرجع نتيجتها كإعادة نظيفة — ما بيوصل لـ`P2002` أصلاً.)
23-ب. نفس `clientOperationId` مع **زبون مختلف** → `409` برسالة `مُعرّف العملية مستخدم لعميل آخر`. هذي الحالة الوحيدة اللي بتولّد ٤٠٩ على هالمسار.
24. دفعتان متزامنتان بمفتاحين مختلفين على نفس الزبون → المجموع صحيح، لا صرف مزدوج للرصيد.
25. إنشاء فاتورة أونلاين متزامن مع دفعة على نفس الزبون → الرصيد ما بينصرف مرتين، ولا deadlock.
26. `PATCH /api/invoices/:id` متزامن مع `POST /api/debts/customer/:id/pay` على نفس الزبون → الاتنين بينجحوا بالتسلسل، **ولا deadlock ولا 500**.
27. نفس السيناريو مع `DELETE /api/invoices/:id`.

### سلامة قاعدة البيانات

28. `UPDATE` خام يحاول يخلّي `creditBalance = −1` → القيد يرفض.
29. بعد كل سيناريو أعلاه: `Σ credit_entries.delta = customers.creditBalance` لكل زبون.
30. بعد كل سيناريو أعلاه: `debts.paid + debts.remaining = debts.amount` و `invoices.paid + invoices.remaining = invoices.total` لكل صف.
31. حساب `0.1 + 0.2` عبر دفعتين → `0.3` بالضبط.
32. كل حقول المال في رد واحد بنفس الصيغة — `creditBalance` و `balance` و `totalRemaining` كلها نصوص `.toString()`، ولا واحد فيها `.toFixed(2)`.

### التقارير

33. دفع ١٥٠ على دين ١٠٠ → `daily-sales.totalCreditReceived = 50`.
34. نفس الدفعة ثم حذفها نفس اليوم → `totalCreditReceived = 0`.
35. فاتورة أكلت ٥٠ رصيد → `daily-sales.totalCreditApplied = 50`.
36. نفس الفاتورة تُحذف نفس اليوم → `totalCreditApplied = 0`.
37. سيناريو رصيد صرف بحت (دفع زائد ثم فاتورة أكلت الرصيد، بدون أي حذف أو تعديل فاتورة) → `getDailyProfit` نفس الرقم بالضبط قبل وبعد.
38. زبون رصيده يغطّي دينه → مشال من قائمة الـ PDF ومن `debtorCount`، و`netRemaining` ما بيعدّه.
39. `totalCredit` و `netRemaining` بيشملوا الزبائن المؤرشفين، مطابقةً لـ `totalRemaining` القائم.
