import axios from 'axios';
import FormData from 'form-data';

export const LARK_BASE_ID = process.env.LARK_BASE_ID || '';

export function getTableId(type: string): string {
  switch (type) {
    case 'attendance': return process.env.LARK_TABLE_ATTENDANCE || '';
    case 'users':      return process.env.LARK_TABLE_USERS || '';
    case 'sites':      return process.env.LARK_TABLE_SITES || '';
    case 'requests':   return process.env.LARK_TABLE_REQUESTS || '';
    default:           return '';
  }
}

export async function getLarkToken(): Promise<string | null> {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) return null;
  try {
    const response = await axios.post(
      'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
      { app_id: appId, app_secret: appSecret }
    );
    return response.data.tenant_access_token;
  } catch {
    return null;
  }
}

export async function uploadLarkAttachment(
  token: string, baseId: string, url: string
): Promise<string | null> {
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
    return uploadResponse.data?.data?.file_token ?? null;
  } catch {
    return null;
  }
}

const READ_ONLY_TYPES = [11, 18, 20, 21, 1001, 1002, 1003, 1004, 1005];

export async function formatBySchema(
  data: Record<string, unknown>,
  fields: any[],
  token: string,
  baseId: string
): Promise<Record<string, unknown>> {
  const clean = Object.fromEntries(
    Object.entries(data).filter(([, v]) => v != null && v !== '')
  );
  if (!fields.length) return clean;

  const formatted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(clean)) {
    const field = fields.find(f =>
      f.field_name.trim().toLowerCase() === key.trim().toLowerCase()
    );
    if (!field) continue;
    const k = field.field_name;

    if (field.type === 5) {
      if (typeof value === 'string' && /^\d{2}:\d{2}$/.test(value)) {
        const [h, m] = value.split(':').map(Number);
        const d = new Date(); d.setHours(h, m, 0, 0);
        formatted[k] = d.getTime();
      } else if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (!isNaN(parsed)) formatted[k] = parsed;
      } else {
        formatted[k] = value;
      }
    } else if (field.type === 1)  { formatted[k] = String(value); }
    else if (field.type === 2)    { formatted[k] = Number(value); }
    else if (field.type === 15)   { formatted[k] = { text: 'Link', link: String(value) }; }
    else if (field.type === 17) {
      if (typeof value === 'string' && value.startsWith('http')) {
        const fileToken = await uploadLarkAttachment(token, baseId, value);
        if (fileToken) formatted[k] = [{ file_token: fileToken }];
      }
    } else if (!READ_ONLY_TYPES.includes(field.type)) {
      formatted[k] = value;
    }
  }
  return formatted;
}

export async function upsertRecord(
  token: string,
  baseId: string,
  tableId: string,
  formatted: Record<string, unknown>
): Promise<void> {
  const idKey = Object.keys(formatted).find(k => k.trim().toLowerCase() === 'id');
  const idValue = idKey ? formatted[idKey] : null;
  let existingId: string | null = null;

  if (idValue) {
    try {
      const searchResp = await axios.post(
        `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records/search`,
        { filter: { conjunction: 'and', conditions: [{ field_name: idKey, operator: 'is', value: [idValue] }] } },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      existingId = searchResp.data?.data?.items?.[0]?.record_id ?? null;
    } catch { /* tạo mới nếu search fail */ }
  }

  if (existingId) {
    await axios.put(
      `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records/${existingId}`,
      { fields: formatted },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } else {
    await axios.post(
      `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records`,
      { fields: formatted },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  }
}
