/**
 * Script cập nhật fullName và employeeCode từ CSV vào Firestore
 * Dùng Firestore REST API với Firebase CLI token (không cần service account)
 *
 * Chạy: node scripts/migrate-fullname.cjs
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const https = require('https');

const PROJECT_ID = 'doremon-youtube';
const DATABASE_ID = 'ai-studio-06f89ebb-f68a-4c5e-8e3a-e05f19a39370';
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;

// Refresh token để lấy access token mới
async function refreshAccessToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      // Firebase CLI OAuth client
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8uo70EpoxDGdY2aTT',
    });
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// HTTP request helper
function httpRequest(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Parse CSV: Stt;Mã NV;Họ và tên;;  / ;;;Mail;
function parseCsv(content) {
  const lines = content.split('\n');
  const records = [];
  for (const line of lines) {
    const parts = line.split(';').map(s => s.trim().replace(/^["'\t\r]|["'\t\r]$/g, '').trim());
    const [, maNV, hoTen, email] = parts;
    if (!maNV || !maNV.startsWith('TL')) continue;
    if (!email || !email.includes('@')) continue;
    if (!hoTen || hoTen.trim() === '') continue;
    records.push({
      employeeCode: maNV.trim(),
      fullName: hoTen.trim(),
      email: email.trim().toLowerCase(),
    });
  }
  return records;
}

// Lấy tất cả users từ Firestore (phân trang)
async function getAllUsers(token) {
  const users = [];
  let pageToken = null;
  do {
    const url = `${BASE_URL}/users?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await httpRequest('GET', url, null, token);
    if (res.status !== 200) {
      throw new Error(`Lỗi lấy users: ${res.status} ${JSON.stringify(res.body).substring(0, 300)}`);
    }
    (res.body.documents || []).forEach(doc => users.push(doc));
    pageToken = res.body.nextPageToken;
  } while (pageToken);
  return users;
}

// Cập nhật document qua PATCH với updateMask
async function patchUser(docName, updates, token) {
  const fields = {};
  for (const [k, v] of Object.entries(updates)) {
    fields[k] = { stringValue: v };
  }
  const fieldPaths = Object.keys(updates).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const url = `https://firestore.googleapis.com/v1/${docName}?${fieldPaths}`;
  return httpRequest('PATCH', url, { fields }, token);
}

// Lấy giá trị string field từ Firestore document
function getField(doc, fieldName) {
  const f = doc.fields && doc.fields[fieldName];
  if (!f) return '';
  return f.stringValue || '';
}

async function main() {
  // Đọc CSV
  const csvPath = path.join(__dirname, '..', 'Họ và tên thật.csv');
  if (!fs.existsSync(csvPath)) {
    console.error('Không tìm thấy file CSV:', csvPath);
    process.exit(1);
  }
  const content = fs.readFileSync(csvPath, 'utf-8');
  const csvRecords = parseCsv(content);
  console.log(`Đọc được ${csvRecords.length} bản ghi từ CSV`);

  const emailMap = new Map();
  for (const r of csvRecords) {
    emailMap.set(r.email, r);
  }

  // Lấy token từ Firebase CLI configstore
  const configPath = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let token = config.tokens.access_token;

  // Kiểm tra token còn hạn không
  const testRes = await httpRequest('GET', `${BASE_URL}/users?pageSize=1`, null, token);
  if (testRes.status === 401) {
    console.log('Token hết hạn, đang refresh...');
    const refreshed = await refreshAccessToken(config.tokens.refresh_token);
    if (!refreshed.access_token) throw new Error('Refresh token thất bại: ' + JSON.stringify(refreshed));
    token = refreshed.access_token;
    console.log('Đã refresh token thành công');
  } else if (testRes.status !== 200) {
    throw new Error(`Token test failed: ${testRes.status} ${JSON.stringify(testRes.body).substring(0, 200)}`);
  }

  // Lấy tất cả users
  const docs = await getAllUsers(token);
  console.log(`Tìm thấy ${docs.length} users trong Firestore\n`);

  let updated = 0;
  let skipped = 0;
  let notFound = 0;
  const firestoreEmails = new Set();

  for (const doc of docs) {
    const userEmail = getField(doc, 'email').trim().toLowerCase();
    firestoreEmails.add(userEmail);

    const csvRecord = emailMap.get(userEmail);
    if (!csvRecord) {
      notFound++;
      continue;
    }

    const updates = {};
    const currentFullName = getField(doc, 'fullName');
    const currentCode = getField(doc, 'employeeCode');

    if (csvRecord.fullName && currentFullName !== csvRecord.fullName) {
      updates.fullName = csvRecord.fullName;
    }
    if (csvRecord.employeeCode && currentCode !== csvRecord.employeeCode) {
      updates.employeeCode = csvRecord.employeeCode;
    }

    if (Object.keys(updates).length === 0) {
      skipped++;
      continue;
    }

    process.stdout.write(`  ✓ ${userEmail}: ${JSON.stringify(updates)}`);
    const patchRes = await patchUser(doc.name, updates, token);
    if (patchRes.status !== 200) {
      console.log(` → LỖI ${patchRes.status}: ${JSON.stringify(patchRes.body).substring(0, 150)}`);
    } else {
      console.log(' → OK');
      updated++;
    }
  }

  console.log('\n=== KẾT QUẢ ===');
  console.log(`✓ Đã cập nhật: ${updated}`);
  console.log(`- Bỏ qua (đã đúng): ${skipped}`);
  console.log(`✗ Không khớp email: ${notFound}`);

  // Email trong CSV nhưng chưa đăng ký app
  const missing = csvRecords.filter(r => !firestoreEmails.has(r.email));
  if (missing.length > 0) {
    console.log(`\nEmail trong CSV chưa đăng ký app (${missing.length}):`);
    missing.forEach(r => console.log(`  - ${r.employeeCode} | ${r.fullName} | ${r.email}`));
  }
}

main().catch(err => {
  console.error('Lỗi:', err.message);
  process.exit(1);
});
