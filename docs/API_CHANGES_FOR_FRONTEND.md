# دليل تغييرات الـ API للفرونتند

> نسخة: بعد المراحل 1→6 (تأمين + Bootstrap + Ledger + Sync + Indexes + Caching/Logging)
> آخر تحديث: 2026-05-22

## ملخّص سريع — TL;DR

| الأولوية | التغيير | الـ Endpoints المتأثرة |
|---|---|---|
| 🔴 **حرج** | المبالغ المالية بقت `string` بدل `number` | كل endpoints الديون والفواتير والتقارير |
| 🟠 **عالي** | `POST /api/sync/push` يرفض overpay بـ 400 | `/api/sync/push` |
| 🟠 **عالي** | شكل `GET /api/health` body اتغيّر | `/api/health` |
| 🟡 **متوسط** | Pagination مقفول على 100 max | كل list endpoints |
| 🟡 **متوسط** | Rate limiting جديد (429) | `/auth/*` |
| 🟡 **متوسط** | Error shape موحّد عبر PrismaExceptionFilter | كل endpoints بـ DB |
| 🟢 **منخفض** | Cross-tenant references → 403 | `/api/sync/push` |
| 🟢 **منخفض** | `?force-fresh=true` على `/api/sync/init` | `/api/sync/init` |
| 🟢 **منخفض** | حذف العميل بقى soft-delete | `DELETE /api/customers/:id` |

**ملاحظات عامة**:
- ❌ ما تم حذف ولا endpoint
- ❌ ما تغيّر اسم ولا URL
- ❌ ما تغيّرت طرق المصادقة (نفس الـ JWT Bearer token)

---

## 1. 🔴 المبالغ المالية بقت Strings بدل Numbers

### السبب
كنا نستخدم JavaScript Numbers مع `.toFixed(2)` للحساب المالي. ده بيسبّب float drift:
```js
0.1 + 0.2 === 0.30000000000000004  // ❌
```
بعد التحديث: السيرفر يحسب بـ Prisma.Decimal (دقة عشرية مطلقة) ويرجّع القيم كـ strings لتفادي فقدان الدقة في JS.

### كيف الفرونت يتعامل معاها

**للعرض**: حوّل لـ `Number` عند الـ rendering فقط:
```ts
// قبل
<span>{invoice.total}</span>

// بعد
<span>{Number(invoice.total).toFixed(2)}</span>

// أو مع تنسيق عربي:
<span>{new Intl.NumberFormat('ar-EG').format(Number(invoice.total))}</span>
```

**للحسابات على الفرونت**: استخدم `decimal.js` أو `big.js` (مش JS Number):
```ts
import Decimal from 'decimal.js';

const total = new Decimal(invoice.total);
const tax = total.times(0.15);
const grandTotal = total.plus(tax);
display(grandTotal.toFixed(2));
```

**للإرسال للسيرفر**: ابعت `number` عادي (السيرفر يحوّل لـ Decimal تلقائياً):
```ts
fetch('/api/debts/123/pay', {
  method: 'POST',
  body: JSON.stringify({ amount: 250.50 }) // number صحيح
});
```

### قائمة الحقول المتأثرة بالتفصيل

#### `POST /api/debts/:id/pay`
```diff
{
  "payment": {
    "id": "uuid",
-   "amount": 60,
+   "amount": "60",
    "date": "2026-05-22T...",
    "notes": null,
    "debtId": "uuid"
  },
  "debt": {
    "id": "uuid",
-   "paid": 60,
+   "paid": "60",
-   "remaining": 40,
+   "remaining": "40",
    "isPaid": false
  }
}
```

#### `POST /api/debts/customer/:customerId/pay`
```diff
{
  "customer": { ... },
- "paymentApplied": 100,
+ "paymentApplied": "100",
  "affectedDebts": [
-   { "debtId": "uuid", "amountPaid": 60, "isPaid": false }
+   { "debtId": "uuid", "amountPaid": "60", "isPaid": false }
  ],
  "summary": {
    "totalDebts": 3,
    "unpaidCount": 1,
-   "totalAmount": 500,
-   "totalPaid": 460,
-   "totalRemaining": 40,
+   "totalAmount": "500",
+   "totalPaid": "460",
+   "totalRemaining": "40"
  }
}
```

#### `GET /api/debts`
كل عنصر في `data[]` فيه `amount`, `paid`, `remaining` (الديسيمالات في الـ Prisma model أصلاً مرجوعة كـ strings).

#### `GET /api/debts/summary`
```diff
{
  "totalDebts": 5,
- "totalAmount": 1500,
- "totalPaid": 800,
- "totalRemaining": 700,
+ "totalAmount": "1500",
+ "totalPaid": "800",
+ "totalRemaining": "700",
  "unpaidCount": 2,
- "unpaidRemaining": 700
+ "unpaidRemaining": "700"
}
```

#### `GET /api/debts/customer/:customerId`
```diff
{
  "customer": { ... },
  "summary": {
    "totalDebts": 3,
    "unpaidCount": 1,
-   "totalAmount": 500,
-   "totalPaid": 460,
-   "totalRemaining": 40,
+   "totalAmount": "500",
+   "totalPaid": "460",
+   "totalRemaining": "40"
  },
  "debts": [ /* amount/paid/remaining strings as well */ ]
}
```

#### `GET /api/customers/:id/debt-summary`
```diff
{
  "customer": { ... },
  "summary": {
-   "totalDebt": 200,
-   "totalPaid": 150,
-   "totalRemaining": 50,
+   "totalDebt": "200",
+   "totalPaid": "150",
+   "totalRemaining": "50",
    "unpaidCount": 1,
    "totalDebts": 2
  }
}
```

#### `POST /api/invoices` + `PATCH /api/invoices/:id` + `GET /api/invoices` + `/:id` + `/by-number/:n`
- `total`, `paid`, `remaining` → strings
- `items[].price`, `items[].unitCost`, `items[].total` → strings

#### `GET /api/invoices/daily-sales`
```diff
{
  "date": "2026-05-22",
  "summary": {
    "invoiceCount": 15,
-   "totalSales": 1200,
-   "totalPaid": 900,
-   "totalCash": 500,
-   "totalOnline": 400,
-   "totalDebt": 300,
+   "totalSales": "1200",
+   "totalPaid": "900",
+   "totalCash": "500",
+   "totalOnline": "400",
+   "totalDebt": "300"
  },
  "invoices": [ /* total/paid/remaining strings */ ]
}
```

### الحقول اللي **ما تغيّرتش**
| النوع | الأمثلة |
|--|--|
| `id` | UUIDs |
| Boolean | `isPaid`, `isActive`, `isDeleted` |
| Integer | `quantity`, `stock`, `number` (رقم الفاتورة), counts |
| Enum | `paymentMethod`, `role`, `status` |
| Date strings | `date`, `createdAt`, `updatedAt` |
| Plain text | `name`, `phone`, `notes` |

---

## 2. 🟠 `POST /api/sync/push` — رفض الـ Overpayment

### قبل
لو دفعة (debt payment) قيمتها أكبر من المتبقي على الدين، السيرفر كان **يخصمها بصمت** للمتبقي ويرجّع 200.

### بعد
السيرفر يرفض الـ payload كله بـ **400** ويرجّع تفاصيل واضحة:
```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "الدفعة 3f2a-...: المبلغ (100) يتجاوز المتبقي على الدين (50). أعد المزامنة بعد جلب آخر الحالة."
}
```

### التعامل المطلوب في الفرونت

```ts
try {
  const res = await api.post('/api/sync/push', payload);
} catch (err) {
  if (err.status === 400 && err.body.message.includes('يتجاوز المتبقي')) {
    // 1. اعرض للكاشير: "بياناتك قديمة، جاري التحديث"
    showToast('بياناتك قديمة، جاري التحديث...');

    // 2. اجلب آخر state من السيرفر
    const fresh = await api.get('/api/sync/init?force-fresh=true');
    db.replaceWith(fresh);

    // 3. اطلب من المستخدم إعادة المحاولة
    promptUserToRetry();
  }
}
```

### السبب
الـ silent capping كان بيخفي bugs على الفرونت (بيانات stale) ويسيب الـ ledger يفترق عن واقع الكاشير.

---

## 3. 🟠 `GET /api/health` — Shape جديد + 503

### قبل
```json
{ "status": "ok" }
```
كان دائماً يرجّع 200 حتى لو الـ DB واقعة.

### بعد (مع `@nestjs/terminus`)
**عندما الـ DB متاحة** (status 200):
```json
{
  "status": "ok",
  "info": {
    "database": { "status": "up" }
  },
  "error": {},
  "details": {
    "database": { "status": "up" }
  }
}
```

**عندما الـ DB واقعة** (status **503**):
```json
{
  "status": "error",
  "info": {},
  "error": {
    "database": {
      "status": "down",
      "message": "..."
    }
  },
  "details": {
    "database": { "status": "down", "message": "..." }
  }
}
```

### التعامل
```ts
const isHealthy = res.ok && res.body.status === 'ok';
// أو
const dbStatus = res.body.details?.database?.status; // 'up' | 'down'
```

---

## 4. 🟡 Pagination مقفولة على 100 max

كل الـ list endpoints (`/customers`, `/products`, `/invoices`, `/debts`, ...) لو الفرونت بعت `?limit=999`:
- ❌ ما هيرجّع 999
- ✅ هيرجّع **100** عنصر فقط
- ✅ الـ `meta.limit` في الـ response هيقول `100` (مش 999)

```json
GET /api/customers?page=1&limit=99999

{
  "data": [ /* 100 عناصر بس */ ],
  "meta": {
    "total": 5234,
    "page": 1,
    "limit": 100,      // ← المُطبَّق فعلاً
    "totalPages": 53
  }
}
```

### التعامل
لو محتاج تنزيل البيانات كلها (مثلاً export)، الفرونت لازم يـ paginate:
```ts
async function fetchAll(endpoint: string) {
  const all = [];
  let page = 1;
  while (true) {
    const res = await api.get(`${endpoint}?page=${page}&limit=100`);
    all.push(...res.data);
    if (page >= res.meta.totalPages) break;
    page++;
  }
  return all;
}
```

---

## 5. 🟡 Rate Limiting (429)

في حدود صارمة على endpoints المصادقة:

| Endpoint | الحد | نافذة |
|--|--|--|
| `POST /api/auth/login` | 5 محاولات | كل دقيقة |
| `POST /api/auth/super-admin/login` | 5 | دقيقة |
| `POST /api/auth/register` | 5 | ساعة |
| `POST /api/auth/verify-email` | 5 | 15 دقيقة |
| `POST /api/auth/forgot-password` | 3 | ساعة |
| `POST /api/auth/reset-password` | 5 | 15 دقيقة |
| باقي endpoints | 200 طلب | دقيقة |

عند الوصول للحد:
```json
HTTP/1.1 429 Too Many Requests

{
  "statusCode": 429,
  "message": "ThrottlerException: Too Many Requests"
}
```

### التعامل في الفرونت
```tsx
if (response.status === 429) {
  // اقرأ Retry-After header (بالثواني) لو موجود
  const retryAfter = response.headers.get('retry-after');
  showError(`تجاوزت عدد المحاولات. حاول بعد ${retryAfter || 60} ثانية.`);
  disableSubmitButtonFor(retryAfter * 1000);
}
```

---

## 6. 🟡 Error Response Shape موحّد

كل أخطاء قاعدة البيانات بقت تطلع بنفس الشكل عبر `PrismaExceptionFilter`:

| Prisma code | HTTP Status | الـ Error |
|--|--|--|
| **P2002** | **409 Conflict** | سجل مكرر (unique violation) |
| **P2025** | **404 Not Found** | السجل غير موجود |
| **P2003** | **400 Bad Request** | مرجع غير صالح (FK violation) |
| **P2000** | **400 Bad Request** | القيمة طويلة جداً |
| **P2014** | **400 Bad Request** | علاقة مطلوبة منتهكة |
| أي خطأ DB آخر | **500** | "حدث خطأ في قاعدة البيانات" |

### مثال
```json
HTTP/1.1 409 Conflict

{
  "statusCode": 409,
  "error": "Conflict",
  "message": "سجل مكرر: القيمة موجودة مسبقاً (email)",
  "code": "P2002",
  "target": "email"
}
```

### التعامل
```ts
function handleApiError(err: ApiError) {
  // إعتمد على `code` بدل ما تفسّر الـ message
  if (err.code === 'P2002') {
    showFieldError(err.target, 'القيمة دي مستخدمة قبل كده');
  } else if (err.code === 'P2025') {
    showError('السجل المطلوب غير موجود');
  } else {
    showError(err.message);
  }
}
```

### قبل التحديث
كانت ترجع 500 مع stack trace كامل (مشكلة أمنية). الآن لا stack traces بتظهر للـ client.

---

## 7. 🟢 Cross-tenant References → 403

في `POST /api/sync/push`، لو الـ payload فيه `customerId` أو `productId` أو `invoiceId` تابع لمتجر تاني:

```json
HTTP/1.1 403 Forbidden

{
  "statusCode": 403,
  "message": "أحد العملاء في الـ payload لا ينتمي إلى متجرك",
  "error": "Forbidden"
}
```

كان بيرجع 500 (FK error) أو حتى ينجح أحياناً.

### التعامل
لو شُفت 403 على push، يعني الـ IndexedDB المحلي عنده بيانات بايتة من تسجيل دخول قديم. اعمل `/sync/init?force-fresh=true` لإعادة seeding من الصفر.

---

## 8. 🟢 `?force-fresh=true` على `/sync/init`

`/sync/init` بقى cached لـ **30 ثانية** في الذاكرة على السيرفر. لو الفرونت محتاج يضمن أحدث بيانات (مثلاً بعد رفض من `/push` أو بعد ما الكاشير عدّل منتج)، يقدر يتجاوز الـ cache:

```
GET /api/sync/init?force-fresh=true
```

أو:
```
GET /api/sync/init?force-fresh=1
```

### متى تستخدمها
- بعد كل 400 من `/sync/push` (إجباري)
- زر "تحديث يدوي" في الواجهة
- بعد التحديثات الإدارية الكبيرة

### متى **لا** تستخدمها
- على كل تحميل للتطبيق (يكسر فايدة الـ cache)

---

## 9. 🟢 حذف العميل (Soft Delete)

`DELETE /api/customers/:id` لسه يرجع **204 No Content** كما كان. لكن داخلياً:

- ✅ العميل ما يتمحيش من الـ DB
- ✅ يتأرشف (يتعلّم `isDeleted = true`)
- ✅ يختفي من القوائم (`/api/customers`, `/api/sync/init`)
- ✅ فواتيره وديونه القديمة بتفضل ظاهرة في سجل المتجر باسمه

### السلوك للفرونت
**نفس السلوك المرئي بالضبط** — العميل يختفي. لكن لو الفرونت كان يفترض إن `id` العميل بيتحرّر للاستخدام مرة تانية، ده مش صحيح بعد التحديث (الـ id يفضل مأخوذ).

### السبب
كان فيه bug في برودكشن: حذف عميل عنده ديون (حتى لو مدفوعة) كان يفشل بـ FK constraint error. الـ soft delete يحل المشكلة.

---

## 10. 🟢 تغييرات صامتة في رسائل الأخطاء

بعض رسائل الأخطاء اتغيّرت لتعطي تفاصيل أوضح. الفرونت لو معتمد على نص الرسالة الحرفي للـ branching، يحتاج تحديث.

### أمثلة
- بيع منتج وهو خلصان: `"الكمية المطلوبة (3 قطعة) من \"اسم المنتج\" تتجاوز المخزون المتوفر (20 قطعة)"` (كان أحياناً بيرجع رسائل أبسط؛ **تحديث 2026-08-09**: بعد إضافة بيع الكرتونة، الرسالة صارت تضيف "قطعة" دايماً بعد الرقمين — حتى في بيع القطعة العادي — لأن الكمية بتتحول لقطع داخلياً لدعم خصم الكراتين. لو الفرونت بيعمل parsing لنص الرسالة، لازم يتحدّث)
- منتج معطّل: `"المنتج \"X\" غير متوفر أو معطّل"` (جديد)

### التوصية
استخدم HTTP status codes و `body.code` للـ branching، مش نص الـ message.

---

## ملحق A — قائمة كاملة بكل الـ Endpoints (للتأكيد، URLs ما تغيّرتش)

### Auth
- `POST /api/auth/register` — تسجيل متجر جديد
- `POST /api/auth/login` — دخول مستخدم
- `POST /api/auth/super-admin/login` — دخول SUPER_ADMIN
- `POST /api/auth/verify-email` — تأكيد البريد بـ OTP
- `POST /api/auth/forgot-password` — طلب reset link
- `POST /api/auth/reset-password` — استخدام الـ reset token

### Customers
- `POST /api/customers` — إنشاء عميل
- `GET /api/customers?page&limit&search` — قائمة العملاء
- `GET /api/customers/:id` — تفاصيل العميل + ديونه + فواتيره
- `GET /api/customers/:id/debt-summary` — ملخص ديون العميل
- `PATCH /api/customers/:id` — تحديث
- `DELETE /api/customers/:id` — أرشفة (soft-delete)

### Products
- `POST /api/products` — إنشاء منتج
- `GET /api/products?page&limit&search&isActive` — قائمة
- `GET /api/products/low-stock` — منتجات قاربت على النفاد
- `GET /api/products/barcode/:barcode` — بحث بالباركود (مع cache 5 دقايق)
- `GET /api/products/:id` — تفاصيل المنتج
- `PATCH /api/products/:id` — تحديث
- `DELETE /api/products/:id` — حذف نهائي

### Invoices
- `POST /api/invoices` — إنشاء فاتورة
- `GET /api/invoices?page&limit&search&paymentMethod&dateFrom&dateTo` — قائمة
- `GET /api/invoices/daily-sales?date=YYYY-MM-DD` — مبيعات يوم
- `GET /api/invoices/:id` — تفاصيل الفاتورة
- `GET /api/invoices/by-number/:n` — بحث برقم الفاتورة
- `PATCH /api/invoices/:id` — تحديث
- `DELETE /api/invoices/:id` — حذف (مع استعادة المخزون)

### Debts
- `GET /api/debts?page&limit&search&customerId&isPaid&dateFrom&dateTo` — قائمة
- `GET /api/debts/summary` — ملخص الديون للمتجر
- `GET /api/debts/customer/:customerId` — كل ديون عميل
- `GET /api/debts/:id` — تفاصيل دين
- `GET /api/debts/:id/payments` — دفعات الدين
- `POST /api/debts/:id/pay` — دفعة على دين محدد
- `POST /api/debts/customer/:customerId/pay` — دفعة موزّعة على ديون عميل
- `DELETE /api/debts/:debtId/payments/:paymentId` — إلغاء دفعة (ADMIN)

### Sync (PWA)
- `GET /api/sync/init?force-fresh=true|1` — بيانات التهيئة الأولية
- `POST /api/sync/push` — رفع البيانات المُنشأة أوف‌لاين

### Reports
- `GET /api/reports/daily-profit?date=YYYY-MM-DD` — الأرباح اليومية

### Health
- `GET /api/health` — فحص صحة السيرفر (لا يحتاج auth)

### Backup (Admin)
- (موجودة قبل وبعد، لم تتغيّر)

### Store / User (Admin)
- (موجودة قبل وبعد، لم تتغيّر)

---

## ملحق B — حدود الـ Sync Push (Phase 4)

`POST /api/sync/push` بقى عنده حدود صارمة لمنع DoS:

| الحقل | الحد الأقصى |
|--|--|
| `invoices.length` | 200 فاتورة في الـ payload الواحد |
| `debts.length` | 500 دين |
| `debtPayments.length` | 1000 دفعة |
| `invoices[].items.length` | 100 بند في الفاتورة |
| حجم الـ payload (إجمالي) | 2MB |

تجاوز الحد → **400** مع رسالة عربية واضحة.

---

## ملحق C — JWT و الـ Headers

### Auth Header (لم يتغيّر)
```
Authorization: Bearer <jwt-token>
```

### CORS
السيرفر بيقبل من `ALLOWED_ORIGINS` فقط (متغيّر بيئة). تأكد دومين الفرونت موجود في الـ allowlist.

### Security Headers (عبر Helmet)
كل response دلوقتي فيه:
- `Strict-Transport-Security` (HSTS)
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Content-Security-Policy` (default)

ما حدش من دول بيأثر على الـ requests، بس بيحمي من XSS وclickjacking.

---

## التواصل

لو في endpoint محدد محتاج توضيح أكتر، أو في حالة edge case معينة مش متغطية هنا، ابعت سؤال محدّد بـ:
- الـ URL
- شكل الـ request body
- شكل الـ response body المتوقّع vs المُستلَم

ها يتم تحديث الـ Markdown ده مع كل phase جديدة.

---

## بيع الكرتونة (2026-08-09)

### المنتجات

`POST /api/products` و `PATCH /api/products/:id` صاروا يقبلوا:

| الحقل | النوع | ملاحظات |
|---|---|---|
| `piecesPerCarton` | `int ≥ 1` | عدد القطع في الكرتونة |
| `cartonPurchasePrice` | `decimal ≥ 0` | سعر شراء الكرتونة |
| `cartonSalePrice` | `decimal ≥ 0` | سعر بيع الكرتونة |
| `cartonCount` | `int ≥ 0` | **الإنشاء فقط** — لا يُقبل في التعديل |

**الحقول الثلاثة الأولى تُرسل معاً أو لا يُرسل أي منها.** إرسال بعضها → `400`.

**⚠️ ثلاث نقاط تخص الواجهة:**

1. **خانة "الكمية" (`stock`) في وضع الكرتونة تعني "قطع فرط إضافية"** وتُجمع فوق قطع الكراتين:
   `المخزون = (cartonCount × piecesPerCarton) + stock`
   مثال: `2 كرتونة × 24 + 5 فرط = 53 قطعة`.
   يُفضَّل تغيير تسمية الخانة في وضع الكرتونة إلى "قطع إضافية فرط" — الكاشير الذي يفهمها كمخزون كلي ويكتب 48 سينتج مخزوناً = 96.

2. **خانة "سعر الجملة" (`wholesalePrice`) تُتجاهل في وضع الكرتونة.** الخادم يحسبها:
   `wholesalePrice = cartonPurchasePrice ÷ piecesPerCarton` (مقرَّبة لمنزلتين).
   يُفضَّل إخفاؤها أو جعلها `readonly` محسوبة.

3. **التعديل لا يعيد حساب المخزون من الكراتين.** إرسال `cartonCount` في `PATCH` → `400`. لتصحيح المخزون استخدم `stock` مباشرة.

`stock` في كل الاستجابات **دائماً بالقطع**، لا بالكراتين.

### الفواتير

`POST /api/invoices` و `PATCH /api/invoices/:id`: كل بند يقبل `saleUnit` اختياري بقيمة `UNIT` (الافتراضي) أو `CARTON`.

عند `CARTON`:
- `quantity` = عدد الكراتين
- السعر والتكلفة يُقرآن من `cartonSalePrice` و `cartonPurchasePrice` المخزَّنين في المنتج — لا تُرسل أسعاراً
- المخزون يُخصم `quantity × piecesPerCarton` قطعة
- بيع كرتونة من منتج بلا بيانات كرتونة → `400`

بيع كراتين وقطع من نفس المنتج في نفس الفاتورة = **بندان مستقلان**.

استجابات `GET /api/invoices/:id` و `GET /api/invoices/number/:n` و `GET /api/customers/:id` صارت ترجع `saleUnit` و `stockQuantity` في كل بند. البنود المُنشأة قبل هذا التحديث ترجع `saleUnit: "UNIT"` و `stockQuantity: null`.

### المزامنة الأوف‌لاين

`POST /api/sync/push`: كل بند يقبل `saleUnit` و `stockQuantity` اختياريين.

**طابور الأوف‌لاين يجب أن يرسل `saleUnit: "CARTON"` مع كل بيعة كرتونة**، ويُفضَّل إرسال `stockQuantity` أيضاً. بدونهما يُخصم المخزون بالقطعة بدل الكرتونة وينحرف المخزون بصمت.
