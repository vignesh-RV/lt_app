# WA Bank Monitor API

Node.js Express API for receiving bank credit JSON from the Android app and storing it in Postgres.

## Setup

1. Create a Postgres database as a Postgres admin user:

```sql
\i api/db/create_database.sql
```

The same setup SQL is available at `api/db/create_database.sql`.

2. Install dependencies:

```powershell
npm install
```

3. Create `.env` from `.env.example` and update `DATABASE_URL` if needed.

4. Run migrations:

```powershell
npm run migrate
```

5. Start the API:

```powershell
npm start
```

The API listens on `http://localhost:3000` by default.

## Endpoints

### Health

```http
GET /health
```

### Create Credit

```http
POST /api/credits
Content-Type: application/json
```

Request body:

```json
{
  "timestamp": 1710000000000,
  "messageSource": "SMS",
  "source": "SMS",
  "appPackage": "android.sms",
  "direction": "credit",
  "amount": "1250.00",
  "sender": "VK-BANK",
  "transactionDateText": "13/05/2026 10:22 AM",
  "payerName": "RAVI KUMAR",
  "payerVpa": "ravi@upi",
  "accountHint": "XX1234",
  "transactionId": "612345678901",
  "uniqueId": "612345678901",
  "deviceId": "android-secure-id",
  "deviceName": "device_code_name",
  "deviceManufacturer": "Samsung",
  "deviceModel": "SM-S921B",
  "phoneNumbers": ["+919876543210"],
  "receivedPhoneNumber": "+919876543210",
  "smsSubscriptionId": "1",
  "rawText": "Original notification or SMS text"
}
```

Response:

```json
{
  "ok": true,
  "credit": {
    "id": 1,
    "uniqueId": "612345678901",
    "amount": "1250.00"
  }
}
```

The insert is idempotent by `uniqueId`. Posting the same credit again updates the existing row instead of creating a duplicate.

### List Credits

```http
GET /api/credits?limit=50
```

### Capture WhatsApp Prediction Message

Use this when the Android app detects a WhatsApp customer message.

```http
POST /api/whatsapp/messages
Content-Type: application/json
```

```json
{
  "whatsappSender": "Customer Name",
  "phoneNumber": "+919876543210",
  "rawText": "single prediction ABC",
  "timestamp": 1710000000000
}
```

If the message matches an active rule in `prediction_pricing_rules`, the API creates a `prediction_requests` row and a pending manual WhatsApp reply in `outbound_messages`.

### Reconcile Payment Proof

Use this after extracting amount, transaction id, and date from the customer screenshot.

```http
POST /api/payment-proofs/reconcile
Content-Type: application/json
```

```json
{
  "whatsappSender": "Customer Name",
  "predictionRequestId": 1,
  "amount": 1000,
  "transactionId": "612345678901",
  "transactionDateText": "13/05/2026 10:22 AM",
  "screenshotPath": "local/path/or/upload/key",
  "rawText": "OCR text from screenshot"
}
```

The API compares the proof with `bank_credit_messages`, creates a `payment_utilizations` row, updates request status, and stores extra balance in `customer_balances` when paid amount is higher than calculated price.

### Parse Payment Proof OCR Text

Use this after OCR converts a screenshot into text.

```http
POST /api/payment-proofs/parse-text
Content-Type: application/json
```

```json
{
  "rawText": "Transaction Successful\n02:53 PM on 07 Apr 2026\nPaid to\nSAKTHI MAHARAJAN SEK ₹35\nTransaction ID\nT2604071453136087420539\nUTR: 985357020401"
}
```

Response fields:

```json
{
  "status": "success",
  "isSuccessful": true,
  "amount": "35",
  "transactionId": "T2604071453136087420539",
  "utr": "985357020401",
  "uniqueReference": "T2604071453136087420539",
  "transactionDateText": "07 Apr 2026",
  "payeeName": "SAKTHI MAHARAJAN SEK",
  "payeeVpa": "nns286360-1@okaxis",
  "payerName": "",
  "payerAccountHint": "XXXXXX8256",
  "appName": "PhonePe"
}
```

Observed screenshot variants in `api/bills`:

- PhonePe full details with Transaction ID and UTR.
- PhonePe / Google Pay style success summary with amount, payee, VPA, and date but no visible transaction id.
- Navi UPI receipt with `UPI txn ID`.
- Processing/pending screens, which are parsed as `status: processing` and should not be treated as confirmed payments.

### OCR Payment Screenshot

Tesseract OCR must be installed and `TESSERACT_PATH` must point to `tesseract.exe`.

```http
POST /api/payment-proofs/ocr
Content-Type: multipart/form-data
```

Form field:

```text
screenshot=<image file>
```

Response:

```json
{
  "ok": true,
  "rawText": "OCR text...",
  "paymentProof": {
    "status": "success",
    "amount": "35",
    "transactionId": "T2604071453136087420539"
  }
}
```

### Pending Manual WhatsApp Replies

```http
GET /api/outbound-messages?limit=50
```

These are messages the Android app can open in WhatsApp for you to send manually.

### Save Show Result And Calculate Winners

```http
POST /api/show-results
Content-Type: application/json
```

```json
{
  "resultDate": "2026-05-14",
  "gameShow": "3PM_KL",
  "market": "KL",
  "winningNumber": "0034",
  "enteredBy": "admin",
  "notes": "manual entry after show"
}
```

This stores the result, recalculates winning lines for matching prediction requests, and returns the winners.

### Result History

```http
GET /api/show-results?limit=30
```

### Winning Customers

```http
GET /api/winners?status=pending_disbursement
```

Optional filter:

```http
GET /api/winners?showResultId=1
```

### Mark Winner Disbursed

```http
POST /api/winners/1/disburse
Content-Type: application/json
```

```json
{
  "reference": "UPI123456",
  "notes": "paid manually"
}
```

## WhatsApp Sending Workaround

Without WhatsApp Business API, a normal Android app should not silently send WhatsApp messages. The reliable workaround is:

1. API creates an `outbound_messages` row.
2. Android app fetches pending rows.
3. Android opens WhatsApp chat with the message prefilled.
4. You tap send.

This keeps the app aligned with Android/WhatsApp restrictions and avoids brittle accessibility automation.

## Game Pricing Rules

The active game rules are stored in `game_pricing_rules`.

Seeded rules:

| Game | Unit Price | Matching | Win Tiers |
| --- | ---: | --- | --- |
| Single Board | 12 | 1 digit numbers | single: 100 |
| 2 Digit AB | 12 | `AB` + 2 digit numbers | AB: 1000 |
| 2 Digit BC | 12 | `BC` + 2 digit numbers | BC: 1000 |
| 2 Digit AC | 12 | `AC` + 2 digit numbers | AC: 1000 |
| 3 Digit | 12 | 3 digit numbers | ABC: 4500, BC: 100 |
| 3 Digit | 25 | 3 digit numbers | ABC: 9000, BC: 1000 |
| 3 Digit | 30 | 3 digit numbers | ABC: 14000, BC: 500, AC: 50 |
| 3 Digit | 60 | 3 digit numbers | ABC: 28000, BC: 1000, AC: 100 |
| 4 Digit Only KL | 100 | 4 digit numbers, KL only | ABCD: 450000, ABC: 10000, BC: 1000, C: 100 |
| 4 Digit KL & Dear | 20 | 4 digit numbers | ABCD: 90000 |

Price calculation is:

```text
calculated_price = unit_price * count_of_valid_numbers
```

Customer shorthand supported by the parser:

- `set` means units. Example: `32 20set` means 20 units.
- `Each 5set` applies 5 units to the previous block.
- `ALL` means A, B, and C in single board, so each digit expands to 3 units.
- `box` with a 2 digit number expands to AB, AC, and BC, so it is 3 units.
- `box` with a 3 digit number expands to unique permutations. Example: `432` is 6 units, `442` is 3 units.
- Duplicates in a list are counted as separate units.
- A price-only line applies to pending prediction lines above it and following lines until another price appears.

Show inference:

- Messages mentioning `KL` are treated as the 3PM KL show.
- Messages mentioning `Dear` or `DR` are treated as Dear.
- If no market is mentioned, the API infers the next show from the received time.
- The current show list is 1PM Dear, 3PM KL, 6PM Dear, and 8PM Dear.
