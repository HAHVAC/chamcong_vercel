/**
 * Script migrate dữ liệu từ database cũ (ai-studio-...) sang database mới (chamcong-db)
 *
 * Cách dùng:
 *   1. Tải service account key từ Firebase Console:
 *      Project Settings → Service accounts → Generate new private key
 *   2. Đặt file JSON vào thư mục gốc project, đặt tên: service-account.json
 *   3. Chạy: node scripts/migrate-database.cjs
 */

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// ─── Config ──────────────────────────────────────────────────────────────────
const PROJECT_ID = 'doremon-youtube';
const OLD_DATABASE = 'ai-studio-06f89ebb-f68a-4c5e-8e3a-e05f19a39370';
const NEW_DATABASE = '(default)';
const COLLECTIONS = ['users', 'sites', 'attendance', 'requests'];
const BATCH_SIZE = 400; // Firestore batch tối đa 500 operations

// ─── Kiểm tra service account key ────────────────────────────────────────────
const SERVICE_ACCOUNT_PATH = path.join(__dirname, '..', 'service-account.json');
if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error('❌ Không tìm thấy service-account.json');
  console.error('   Tải từ: Firebase Console → Project Settings → Service accounts → Generate new private key');
  process.exit(1);
}

const serviceAccount = require(SERVICE_ACCOUNT_PATH);

// ─── Khởi tạo 2 app: old và new database ─────────────────────────────────────
const oldApp = admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${PROJECT_ID}.firebaseio.com`,
}, 'old');

const newApp = admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
}, 'new');

const oldDb = oldApp.firestore();
oldDb.settings({ databaseId: OLD_DATABASE });

const newDb = newApp.firestore();
newDb.settings({ databaseId: NEW_DATABASE });

// ─── Helper: migrate một collection ──────────────────────────────────────────
async function migrateCollection(collectionName) {
  console.log(`\n📦 Đang migrate collection: ${collectionName}`);

  const snapshot = await oldDb.collection(collectionName).get();
  if (snapshot.empty) {
    console.log(`   ⚠️  Collection trống, bỏ qua.`);
    return 0;
  }

  const docs = snapshot.docs;
  console.log(`   Tìm thấy ${docs.length} documents`);

  let migrated = 0;
  // Chia thành các batch để tránh vượt giới hạn
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const chunk = docs.slice(i, i + BATCH_SIZE);
    const batch = newDb.batch();

    for (const docSnap of chunk) {
      const ref = newDb.collection(collectionName).doc(docSnap.id);
      batch.set(ref, docSnap.data());
    }

    await batch.commit();
    migrated += chunk.length;
    console.log(`   ✅ ${migrated}/${docs.length} documents`);
  }

  return migrated;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Bắt đầu migrate dữ liệu Firestore');
  console.log(`   Nguồn: ${OLD_DATABASE}`);
  console.log(`   Đích:  ${NEW_DATABASE}`);
  console.log('─'.repeat(50));

  const summary = {};
  let hasError = false;

  for (const col of COLLECTIONS) {
    try {
      summary[col] = await migrateCollection(col);
    } catch (err) {
      console.error(`   ❌ Lỗi khi migrate ${col}:`, err.message);
      summary[col] = 'LỖI';
      hasError = true;
    }
  }

  console.log('\n' + '═'.repeat(50));
  console.log('📊 Kết quả migrate:');
  for (const [col, count] of Object.entries(summary)) {
    console.log(`   ${col}: ${count} documents`);
  }

  if (hasError) {
    console.log('\n⚠️  Có lỗi xảy ra. Kiểm tra output bên trên.');
  } else {
    console.log('\n✅ Migrate hoàn tất! App đã sẵn sàng dùng database mới.');
  }

  process.exit(hasError ? 1 : 0);
}

main().catch(err => {
  console.error('❌ Lỗi nghiêm trọng:', err);
  process.exit(1);
});
