import 'dotenv/config';
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import cors from "cors";
import axios from "axios";
import FormData from "form-data";

async function startServer() {
  const app = express();
  const PORT = 3001;

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // Lark Base Configuration
  const LARK_APP_ID = process.env.LARK_APP_ID;
  const LARK_APP_SECRET = process.env.LARK_APP_SECRET;
  const LARK_BASE_ID = process.env.LARK_BASE_ID;

  // Function to get Lark Tenant Access Token
  async function getLarkToken() {
    if (!LARK_APP_ID || !LARK_APP_SECRET) return null;
    try {
      const response = await axios.post('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: LARK_APP_ID,
        app_secret: LARK_APP_SECRET
      });
      return response.data.tenant_access_token;
    } catch (error) {
      console.error('Error getting Lark token:', error);
      return null;
    }
  }

  // Function to upload attachment to Lark
  async function uploadLarkAttachment(token: string, baseId: string, url: string) {
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
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...formData.getHeaders()
          }
        }
      );

      return uploadResponse.data?.data?.file_token;
    } catch (error: any) {
      console.error('Error uploading attachment to Lark:', error.response?.data || error.message);
      return null;
    }
  }

  // API endpoint for Lark Sync
  app.post("/api/sync/lark", async (req, res) => {
    const { type, data } = req.body;
    const token = await getLarkToken();

    if (!token || !LARK_BASE_ID) {
      return res.status(500).json({ error: "Lark configuration missing" });
    }

    let tableId = "";
    switch (type) {
      case 'attendance': tableId = process.env.LARK_TABLE_ATTENDANCE || ""; break;
      case 'users': tableId = process.env.LARK_TABLE_USERS || ""; break;
      case 'sites': tableId = process.env.LARK_TABLE_SITES || ""; break;
      case 'requests': tableId = process.env.LARK_TABLE_REQUESTS || ""; break;
    }

    if (!tableId) {
      return res.status(400).json({ error: "Table ID missing for type: " + type });
    }

    try {
      let existingRecordId = null;

      // Clean data: remove undefined, null, or empty string values
      let cleanData = Object.fromEntries(
        Object.entries(data).filter(([_, v]) => v != null && v !== "")
      );

      // Fetch table schema to format data correctly
      try {
        const fieldsResponse = await axios.get(
          `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_BASE_ID}/tables/${tableId}/fields`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const fields = fieldsResponse.data?.data?.items || [];
        
        const formattedData: any = {};
        for (const [key, value] of Object.entries(cleanData)) {
          // Find field case-insensitively, ignoring leading/trailing spaces
          const field = fields.find((f: any) => f.field_name.trim().toLowerCase() === key.trim().toLowerCase());
          
          if (field) {
            const actualKey = field.field_name;
            if (field.type === 5) { // Date/Time
              if (typeof value === 'string') {
                // Try to parse "HH:mm"
                if (/^\d{2}:\d{2}$/.test(value)) {
                  const [hours, minutes] = value.split(':').map(Number);
                  const date = new Date();
                  date.setHours(hours, minutes, 0, 0);
                  formattedData[actualKey] = date.getTime();
                } else {
                  const parsed = Date.parse(value);
                  if (!isNaN(parsed)) {
                    formattedData[actualKey] = parsed;
                  } else {
                    formattedData[actualKey] = value;
                  }
                }
              } else {
                formattedData[actualKey] = value; // Already a number (timestamp)
              }
            } else if (field.type === 1) { // Text
              formattedData[actualKey] = String(value);
            } else if (field.type === 2) { // Number
              formattedData[actualKey] = Number(value);
            } else if (field.type === 15) { // Link
              formattedData[actualKey] = { text: "Link", link: String(value) };
            } else if (field.type === 17) { // Attachment
              if (typeof value === 'string' && value.startsWith('http')) {
                const fileToken = await uploadLarkAttachment(token, LARK_BASE_ID, value);
                if (fileToken) {
                  formattedData[actualKey] = [{ file_token: fileToken }];
                } else {
                  console.warn(`Failed to upload attachment for field ${key}, omitting.`);
                }
              } else {
                console.warn(`Invalid attachment URL for field ${key}, omitting.`);
              }
            } else if (field.type === 11 || field.type === 18 || field.type === 20 || field.type === 21 || field.type === 1001 || field.type === 1002 || field.type === 1003 || field.type === 1004 || field.type === 1005) {
              // Person (11), Link to other records (18), Formula (20), Duplex Link (21)
              // Read-only fields: Created Time (1001), Modified Time (1002), Created By (1003), Modified By (1004), Auto Number (1005)
              // Sending data to these will cause 400 Bad Request. We will omit them.
              console.warn(`Field ${key} is of unsupported/read-only type ${field.type}, omitting to prevent error.`);
            } else {
              formattedData[actualKey] = value;
            }
          } else {
            // Field not found in schema, omit it to prevent 400 Bad Request
            console.warn(`Field ${key} not found in Lark schema, omitting.`);
          }
        }
        cleanData = formattedData;
      } catch (schemaError: any) {
        console.warn('Failed to fetch Lark table schema, proceeding with raw data:', schemaError.response?.data || schemaError.message);
      }

      // Find the actual key used for ID in cleanData
      const idKey = Object.keys(cleanData).find(k => k.trim().toLowerCase() === 'id');
      const recordIdValue = idKey ? cleanData[idKey] : null;

      if (Object.keys(cleanData).length === 0) {
        return res.status(400).json({ 
          error: "Không có trường dữ liệu nào khớp với bảng trên Lark Base.",
          details: { msg: "Vui lòng kiểm tra lại tên các cột trong Lark Base xem đã khớp chính xác với ứng dụng chưa (ví dụ: 'ID', 'Nhân viên', 'Giờ vào', 'Giờ ra', ...)." }
        });
      }

      // If data has an ID, try to find existing record
      if (recordIdValue) {
        try {
          const searchResponse = await axios.post(
            `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_BASE_ID}/tables/${tableId}/records/search`,
            {
              filter: {
                conjunction: "and",
                conditions: [
                  {
                    field_name: idKey,
                    operator: "is",
                    value: [recordIdValue]
                  }
                ]
              }
            },
            { headers: { Authorization: `Bearer ${token}` } }
          );

          if (searchResponse.data?.data?.items && searchResponse.data.data.items.length > 0) {
            existingRecordId = searchResponse.data.data.items[0].record_id;
          }
        } catch (searchError: any) {
          console.warn('Lark search failed, will attempt to create new record:', searchError.response?.data || searchError.message);
        }
      }

      let response;
      if (existingRecordId) {
        // Update existing record
        response = await axios.put(
          `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_BASE_ID}/tables/${tableId}/records/${existingRecordId}`,
          { fields: cleanData },
          { headers: { Authorization: `Bearer ${token}` } }
        );
      } else {
        // Create new record
        response = await axios.post(
          `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_BASE_ID}/tables/${tableId}/records`,
          { fields: cleanData },
          { headers: { Authorization: `Bearer ${token}` } }
        );
      }

      res.json({ success: true, record: response.data, action: existingRecordId ? 'updated' : 'created' });
    } catch (error: any) {
      console.error('Error syncing to Lark:', error.response?.data || error.message);
      res.status(500).json({ error: "Sync failed", details: error.response?.data });
    }
  });

  // API endpoint for Lark Batch Sync
  app.post("/api/sync/lark/batch", async (req, res) => {
    const { type, records } = req.body;

    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: "Danh sách bản ghi trống." });
    }

    const token = await getLarkToken();
    if (!token || !LARK_BASE_ID) {
      return res.status(500).json({ error: "Lark configuration missing" });
    }

    let tableId = "";
    switch (type) {
      case 'attendance': tableId = process.env.LARK_TABLE_ATTENDANCE || ""; break;
      case 'users': tableId = process.env.LARK_TABLE_USERS || ""; break;
      case 'sites': tableId = process.env.LARK_TABLE_SITES || ""; break;
      case 'requests': tableId = process.env.LARK_TABLE_REQUESTS || ""; break;
    }

    if (!tableId) {
      return res.status(400).json({ error: "Table ID missing for type: " + type });
    }

    // Lấy schema 1 lần cho cả batch
    let fields: any[] = [];
    try {
      const fieldsResponse = await axios.get(
        `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_BASE_ID}/tables/${tableId}/fields`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      fields = fieldsResponse.data?.data?.items || [];
    } catch (err: any) {
      console.warn('Batch: failed to fetch schema:', err.response?.data || err.message);
    }

    // Format 1 bản ghi theo schema
    const formatRecord = async (data: Record<string, any>): Promise<Record<string, any>> => {
      const clean = Object.fromEntries(
        Object.entries(data).filter(([_, v]) => v != null && v !== "")
      );
      if (!fields.length) return clean;

      const formatted: any = {};
      for (const [key, value] of Object.entries(clean)) {
        const field = fields.find((f: any) => f.field_name.trim().toLowerCase() === key.trim().toLowerCase());
        if (!field) continue;
        const actualKey = field.field_name;
        if (field.type === 5) {
          if (typeof value === 'string') {
            if (/^\d{2}:\d{2}$/.test(value)) {
              const [h, m] = value.split(':').map(Number);
              const d = new Date(); d.setHours(h, m, 0, 0);
              formatted[actualKey] = d.getTime();
            } else {
              const parsed = Date.parse(value);
              if (!isNaN(parsed)) formatted[actualKey] = parsed;
            }
          } else {
            formatted[actualKey] = value;
          }
        } else if (field.type === 1) {
          formatted[actualKey] = String(value);
        } else if (field.type === 2) {
          formatted[actualKey] = Number(value);
        } else if (field.type === 15) {
          formatted[actualKey] = { text: "Link", link: String(value) };
        } else if (field.type === 17) {
          if (typeof value === 'string' && value.startsWith('http')) {
            const fileToken = await uploadLarkAttachment(token, LARK_BASE_ID, value);
            if (fileToken) formatted[actualKey] = [{ file_token: fileToken }];
          }
        } else if ([11, 18, 20, 21, 1001, 1002, 1003, 1004, 1005].includes(field.type)) {
          // Bỏ qua các field read-only
        } else {
          formatted[actualKey] = value;
        }
      }
      return formatted;
    };

    let success = 0;
    let failed = 0;

    for (const record of records) {
      try {
        const formatted = await formatRecord(record);
        if (Object.keys(formatted).length === 0) { failed++; continue; }

        // Tìm record cũ theo ID
        const idKey = Object.keys(formatted).find(k => k.trim().toLowerCase() === 'id');
        const recordIdValue = idKey ? formatted[idKey] : null;
        let existingRecordId = null;

        if (recordIdValue) {
          try {
            const searchResp = await axios.post(
              `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_BASE_ID}/tables/${tableId}/records/search`,
              {
                filter: {
                  conjunction: "and",
                  conditions: [{ field_name: idKey, operator: "is", value: [recordIdValue] }]
                }
              },
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (searchResp.data?.data?.items?.length > 0) {
              existingRecordId = searchResp.data.data.items[0].record_id;
            }
          } catch { /* tạo mới nếu không tìm được */ }
        }

        if (existingRecordId) {
          await axios.put(
            `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_BASE_ID}/tables/${tableId}/records/${existingRecordId}`,
            { fields: formatted },
            { headers: { Authorization: `Bearer ${token}` } }
          );
        } else {
          await axios.post(
            `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_BASE_ID}/tables/${tableId}/records`,
            { fields: formatted },
            { headers: { Authorization: `Bearer ${token}` } }
          );
        }
        success++;
      } catch (err: any) {
        console.error('Batch sync error for record:', err.response?.data || err.message);
        failed++;
      }
    }

    res.json({ success, failed, total: records.length });
  });

  // API endpoint for Lark Test
  app.get("/api/sync/lark/test", async (req, res) => {
    const token = await getLarkToken();
    if (!token) {
      return res.status(500).json({ error: "Lỗi cấu hình Lark: Không thể lấy Access Token. Kiểm tra LARK_APP_ID và LARK_APP_SECRET." });
    }

    if (!LARK_BASE_ID) {
      return res.status(500).json({ error: "Lỗi cấu hình Lark: Thiếu LARK_BASE_ID." });
    }

    try {
      // Test getting tables from the base
      const response = await axios.get(
        `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_BASE_ID}/tables`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      const tables = response.data.data.items || [];
      const tableNames = tables.map((t: any) => ({ id: t.table_id, name: t.name }));

      res.json({
        success: true,
        message: "Kết nối Lark Base thành công!",
        baseId: LARK_BASE_ID,
        tablesFound: tableNames,
        configuredTables: {
          attendance: process.env.LARK_TABLE_ATTENDANCE || "Chưa cấu hình",
          users: process.env.LARK_TABLE_USERS || "Chưa cấu hình",
          sites: process.env.LARK_TABLE_SITES || "Chưa cấu hình",
          requests: process.env.LARK_TABLE_REQUESTS || "Chưa cấu hình"
        }
      });
    } catch (error: any) {
      console.error('Error testing Lark connection:', error.response?.data || error.message);
      res.status(500).json({ 
        error: "Lỗi khi truy cập Lark Base. Kiểm tra lại LARK_BASE_ID hoặc quyền truy cập của App.", 
        details: error.response?.data 
      });
    }
  });

  // API endpoint chẩn đoán cấu hình Lark (không lộ giá trị thực)
  app.get("/api/sync/lark/debug", async (req, res) => {
    const vars = {
      LARK_APP_ID: !!process.env.LARK_APP_ID,
      LARK_APP_SECRET: !!process.env.LARK_APP_SECRET,
      LARK_BASE_ID: !!process.env.LARK_BASE_ID,
      LARK_TABLE_ATTENDANCE: !!process.env.LARK_TABLE_ATTENDANCE,
      LARK_TABLE_USERS: !!process.env.LARK_TABLE_USERS,
      LARK_TABLE_SITES: !!process.env.LARK_TABLE_SITES,
      LARK_TABLE_REQUESTS: !!process.env.LARK_TABLE_REQUESTS,
    };

    // Thử lấy token
    let tokenStatus: string;
    let tokenError: any = null;
    try {
      const token = await getLarkToken();
      tokenStatus = token ? 'OK' : 'FAIL - getLarkToken trả về null';
    } catch (err: any) {
      tokenStatus = 'ERROR';
      tokenError = err.response?.data || err.message;
    }

    // Kiểm tra từng table ID có tìm thấy trong Lark không
    let tableCheck: Record<string, string> = {};
    if (tokenStatus === 'OK' && process.env.LARK_BASE_ID) {
      const token = await getLarkToken();
      const tableMap: Record<string, string | undefined> = {
        attendance: process.env.LARK_TABLE_ATTENDANCE,
        users: process.env.LARK_TABLE_USERS,
        sites: process.env.LARK_TABLE_SITES,
        requests: process.env.LARK_TABLE_REQUESTS,
      };
      for (const [name, tableId] of Object.entries(tableMap)) {
        if (!tableId) { tableCheck[name] = 'MISSING'; continue; }
        try {
          await axios.get(
            `https://open.larksuite.com/open-apis/bitable/v1/apps/${process.env.LARK_BASE_ID}/tables/${tableId}/fields`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          tableCheck[name] = 'OK';
        } catch (err: any) {
          const code = err.response?.data?.code;
          tableCheck[name] = code ? `FAIL (Lark code: ${code})` : `FAIL (${err.message})`;
        }
      }
    }

    res.json({ envVars: vars, tokenStatus, tokenError, tableCheck });
  });

  // API endpoint for server time
  app.get("/api/time", (req, res) => {
    res.json({ timestamp: Date.now() });
  });

  // API endpoint for health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
