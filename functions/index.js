const { onRequest } = require('firebase-functions/v2/https');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '10mb' }));

// Lark Base Configuration — đọc từ Firebase Function environment
const LARK_APP_ID = process.env.LARK_APP_ID;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET;
const LARK_BASE_ID = process.env.LARK_BASE_ID;

async function getLarkToken() {
  if (!LARK_APP_ID || !LARK_APP_SECRET) return null;
  try {
    const response = await axios.post(
      'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
      { app_id: LARK_APP_ID, app_secret: LARK_APP_SECRET }
    );
    return response.data.tenant_access_token;
  } catch (error) {
    console.error('Error getting Lark token:', error);
    return null;
  }
}

async function uploadLarkAttachment(token, baseId, url) {
  try {
    const imageResponse = await axios.get(url, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(imageResponse.data, 'binary');
    const formData = new FormData();
    formData.append('file_name', 'image.jpg');
    formData.append('parent_type', 'bitable_image');
    formData.append('parent_node', baseId);
    formData.append('size', buffer.length);
    formData.append('file', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
    const uploadResponse = await axios.post(
      'https://open.larksuite.com/open-apis/drive/v1/medias/upload_all',
      formData,
      { headers: { Authorization: `Bearer ${token}`, ...formData.getHeaders() } }
    );
    return uploadResponse.data?.data?.file_token;
  } catch (error) {
    console.error('Error uploading attachment to Lark:', error.response?.data || error.message);
    return null;
  }
}

// Helper: format record fields theo Lark schema
async function formatBySchema(data, fields, token, baseId) {
  const clean = Object.fromEntries(
    Object.entries(data).filter(([_, v]) => v != null && v !== '')
  );
  if (!fields.length) return clean;

  const READ_ONLY = [11, 18, 20, 21, 1001, 1002, 1003, 1004, 1005];
  const formatted = {};
  for (const [key, value] of Object.entries(clean)) {
    const field = fields.find(f => f.field_name.trim().toLowerCase() === key.trim().toLowerCase());
    if (!field) continue;
    const k = field.field_name;
    if (field.type === 5) {
      if (typeof value === 'string') {
        if (/^\d{2}:\d{2}$/.test(value)) {
          const [h, m] = value.split(':').map(Number);
          const d = new Date(); d.setHours(h, m, 0, 0);
          formatted[k] = d.getTime();
        } else {
          const parsed = Date.parse(value);
          if (!isNaN(parsed)) formatted[k] = parsed;
        }
      } else { formatted[k] = value; }
    } else if (field.type === 1) { formatted[k] = String(value); }
    else if (field.type === 2) { formatted[k] = Number(value); }
    else if (field.type === 15) { formatted[k] = { text: 'Link', link: String(value) }; }
    else if (field.type === 17) {
      if (typeof value === 'string' && value.startsWith('http')) {
        const fileToken = await uploadLarkAttachment(token, baseId, value);
        if (fileToken) formatted[k] = [{ file_token: fileToken }];
      }
    } else if (READ_ONLY.includes(field.type)) { /* bỏ qua */ }
    else { formatted[k] = value; }
  }
  return formatted;
}

// Helper: upsert 1 record vào Lark
async function upsertRecord(token, baseId, tableId, formatted) {
  const idKey = Object.keys(formatted).find(k => k.trim().toLowerCase() === 'id');
  const idValue = idKey ? formatted[idKey] : null;
  let existingId = null;

  if (idValue) {
    try {
      const searchResp = await axios.post(
        `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records/search`,
        { filter: { conjunction: 'and', conditions: [{ field_name: idKey, operator: 'is', value: [idValue] }] } },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      existingId = searchResp.data?.data?.items?.[0]?.record_id ?? null;
    } catch { /* tạo mới */ }
  }

  if (existingId) {
    return axios.put(
      `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records/${existingId}`,
      { fields: formatted },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  }
  return axios.post(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records`,
    { fields: formatted },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

function getTableId(type) {
  switch (type) {
    case 'attendance': return process.env.LARK_TABLE_ATTENDANCE || '';
    case 'users':      return process.env.LARK_TABLE_USERS || '';
    case 'sites':      return process.env.LARK_TABLE_SITES || '';
    case 'requests':   return process.env.LARK_TABLE_REQUESTS || '';
    default:           return '';
  }
}

// POST /api/sync/lark — sync 1 record
app.post('/api/sync/lark', async (req, res) => {
  const { type, data } = req.body;
  const token = await getLarkToken();
  if (!token || !LARK_BASE_ID) return res.status(500).json({ error: 'Lark configuration missing' });

  const tableId = getTableId(type);
  if (!tableId) return res.status(400).json({ error: 'Table ID missing for type: ' + type });

  try {
    let cleanData = Object.fromEntries(Object.entries(data).filter(([_, v]) => v != null && v !== ''));
    try {
      const fieldsResp = await axios.get(
        `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_BASE_ID}/tables/${tableId}/fields`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const fields = fieldsResp.data?.data?.items || [];
      cleanData = await formatBySchema(cleanData, fields, token, LARK_BASE_ID);
    } catch (e) { console.warn('Schema fetch failed, using raw data'); }

    if (!Object.keys(cleanData).length) {
      return res.status(400).json({ error: 'Không có trường dữ liệu nào khớp với bảng Lark.', details: { msg: 'Kiểm tra tên cột trong Lark Base.' } });
    }

    const response = await upsertRecord(token, LARK_BASE_ID, tableId, cleanData);
    res.json({ success: true, record: response.data, action: 'upserted' });
  } catch (error) {
    console.error('Sync error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Sync failed', details: error.response?.data });
  }
});

// POST /api/sync/lark/batch — sync nhiều records
app.post('/api/sync/lark/batch', async (req, res) => {
  const { type, records } = req.body;
  if (!Array.isArray(records) || records.length === 0) return res.status(400).json({ error: 'Danh sách bản ghi trống.' });

  const token = await getLarkToken();
  if (!token || !LARK_BASE_ID) return res.status(500).json({ error: 'Lark configuration missing' });

  const tableId = getTableId(type);
  if (!tableId) return res.status(400).json({ error: 'Table ID missing for type: ' + type });

  let fields = [];
  try {
    const fieldsResp = await axios.get(
      `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_BASE_ID}/tables/${tableId}/fields`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    fields = fieldsResp.data?.data?.items || [];
  } catch (e) { console.warn('Batch: schema fetch failed'); }

  let success = 0, failed = 0;
  for (const record of records) {
    try {
      const formatted = await formatBySchema(record, fields, token, LARK_BASE_ID);
      if (!Object.keys(formatted).length) { failed++; continue; }
      await upsertRecord(token, LARK_BASE_ID, tableId, formatted);
      success++;
    } catch (e) {
      console.error('Batch record error:', e.response?.data || e.message);
      failed++;
    }
  }
  res.json({ success, failed, total: records.length });
});

// GET /api/sync/lark/test — kiểm tra kết nối
app.get('/api/sync/lark/test', async (req, res) => {
  const token = await getLarkToken();
  if (!token) return res.status(500).json({ error: 'Không thể lấy Access Token. Kiểm tra LARK_APP_ID và LARK_APP_SECRET.' });
  if (!LARK_BASE_ID) return res.status(500).json({ error: 'Thiếu LARK_BASE_ID.' });
  try {
    const response = await axios.get(
      `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_BASE_ID}/tables`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const tables = (response.data.data.items || []).map(t => ({ id: t.table_id, name: t.name }));
    res.json({
      success: true,
      message: 'Kết nối Lark Base thành công!',
      baseId: LARK_BASE_ID,
      tablesFound: tables,
      configuredTables: {
        attendance: process.env.LARK_TABLE_ATTENDANCE || 'Chưa cấu hình',
        users:      process.env.LARK_TABLE_USERS      || 'Chưa cấu hình',
        sites:      process.env.LARK_TABLE_SITES      || 'Chưa cấu hình',
        requests:   process.env.LARK_TABLE_REQUESTS   || 'Chưa cấu hình',
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Lỗi khi truy cập Lark Base.', details: error.response?.data });
  }
});

// GET /api/sync/lark/debug — chẩn đoán
app.get('/api/sync/lark/debug', async (req, res) => {
  const vars = {
    LARK_APP_ID: !!LARK_APP_ID, LARK_APP_SECRET: !!LARK_APP_SECRET, LARK_BASE_ID: !!LARK_BASE_ID,
    LARK_TABLE_ATTENDANCE: !!process.env.LARK_TABLE_ATTENDANCE, LARK_TABLE_USERS: !!process.env.LARK_TABLE_USERS,
    LARK_TABLE_SITES: !!process.env.LARK_TABLE_SITES, LARK_TABLE_REQUESTS: !!process.env.LARK_TABLE_REQUESTS,
  };
  const token = await getLarkToken();
  const tokenStatus = token ? 'OK' : 'FAIL';
  res.json({ envVars: vars, tokenStatus, tableCheck: {} });
});

// GET /api/health
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/time',   (req, res) => res.json({ timestamp: Date.now() }));

// Export Cloud Function
exports.api = onRequest({ region: 'asia-southeast1', memory: '256MiB', timeoutSeconds: 60 }, app);
