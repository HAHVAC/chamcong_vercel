export interface AttendanceRecord {
  id?: string;
  userId: string;
  userName: string;
  timestamp: number;
  type: 'check-in' | 'check-out';
  location: {
    latitude: number;
    longitude: number;
    accuracy: number;
  };
  photoUrl: string; // Base64 or Firebase Storage URL
  siteId: string;
  siteName: string;
  isSynced: boolean;
}

export interface Site {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius: number; // in meters
  checkInTime?: string;
  checkOutTime?: string;
  imageUrl?: string;
  lunchBreakMinutes?: number; // Thời gian nghỉ trưa (phút), mặc định 120
}

export interface UserProfile {
  uid: string;
  displayName: string;
  fullName?: string; // Họ và tên thật do admin nhập, ưu tiên hiển thị hơn displayName
  email: string;
  employeeCode?: string;
  role: 'engineer' | 'worker' | 'admin' | 'manager';
  verified?: boolean;
  assignedSiteIds?: string[];
  siteRoles?: Record<string, 'worker' | 'view_only'>;
  managerName?: string;
  managerEmail?: string;
  managerUid?: string; // UID của manager — dùng để lưu vào request khi nhân viên gửi
}

export type WorkRequestType = 'leave' | 'overtime' | 'late' | 'early_leave' | 'forgot_checkin' | 'forgot_checkout' | 'sunday_holiday';

export interface WorkRequest {
  id?: string;
  userId: string;
  userName: string;
  fullName?: string; // Họ và tên thật — lưu khi tạo request để hiển thị đúng
  type: WorkRequestType;
  date: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD (optional, for multi-day leave)
  startTime?: string; // HH:mm (optional, for overtime/late/early)
  endTime?: string; // HH:mm (optional, for overtime/late/early)
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  managerComment?: string;
  managerEmail?: string;
  managerName?: string;
  managerId?: string; // UID của manager — dùng so sánh trong Firestore rules
}
