import React, { useState, useEffect, useMemo } from 'react';
import { db, storage, auth } from '../firebase';
import { collection, addDoc, onSnapshot, deleteDoc, doc, updateDoc, query, orderBy, getDocs, where } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { Site, UserProfile, WorkRequest, WorkRequestType, AttendanceRecord } from '../types';
import { UserTableRow } from './UserTableRow';
import { MapPin, Plus, Trash2, Loader2, AlertTriangle, Users, Building2, Clock, Check, Edit2, Save, X, Image as ImageIcon, ChevronLeft, ChevronRight, Search, Filter, User, ShieldCheck, HardHat, FileText, CheckCircle, XCircle, Settings, RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';
import { syncToLark, bulkSyncToLark, LarkSyncType } from '../lib/larkSync';
import { invalidateSitesCache } from '../lib/sitesCache';

interface AdminPanelProps {
  isAdmin?: boolean;
  isManager?: boolean;
}

export const AdminPanel: React.FC<AdminPanelProps> = ({ isAdmin, isManager }) => {
  const [activeTab, setActiveTab] = useState<'sites' | 'users' | 'requests' | 'settings'>(isAdmin ? 'sites' : 'requests');
  const [sites, setSites] = useState<Site[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [requests, setRequests] = useState<WorkRequest[]>([]);
  const [larkTestStatus, setLarkTestStatus] = useState<{ loading: boolean; result: any | null; error: string | null }>({ loading: false, result: null, error: null });
  const [larkDebugStatus, setLarkDebugStatus] = useState<{ loading: boolean; result: any | null }>({ loading: false, result: null });

  interface BulkSyncState {
    loading: boolean;
    success: number;
    failed: number;
    total: number;
    done: boolean;
  }
  const defaultBulkSync: BulkSyncState = { loading: false, success: 0, failed: 0, total: 0, done: false };
  const [bulkSyncStatus, setBulkSyncStatus] = useState<Record<LarkSyncType, BulkSyncState>>({
    attendance: defaultBulkSync,
    users: defaultBulkSync,
    sites: defaultBulkSync,
    requests: defaultBulkSync,
  });

  // Date range cho bulk sync attendance — mặc định tháng hiện tại
  const now = new Date();
  const defaultDateFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const defaultDateTo = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  const [syncDateFrom, setSyncDateFrom] = useState(defaultDateFrom);
  const [syncDateTo, setSyncDateTo] = useState(defaultDateTo);

  const [loading, setLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [editingSiteId, setEditingSiteId] = useState<string | null>(null);
  const [editSiteData, setEditSiteData] = useState<Partial<Site>>({});
  const [newSiteImage, setNewSiteImage] = useState<File | null>(null);
  const [editSiteImage, setEditSiteImage] = useState<File | null>(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  
  const [sitesPage, setSitesPage] = useState(1);
  const [usersPage, setUsersPage] = useState(1);
  const [userSearch, setUserSearch] = useState('');
  const [userFilter, setUserFilter] = useState<'all' | 'verified' | 'unverified'>('all');
  const ITEMS_PER_PAGE = 10;
  
  const [newSite, setNewSite] = useState({
    name: '',
    latitude: '',
    longitude: '',
    radius: '100',
    checkInTime: '07:30',
    checkOutTime: '17:30'
  });

  useEffect(() => {
    if (!isAdmin && !isManager) return;

    const unsubscribeSites = onSnapshot(collection(db, 'sites'), (snapshot) => {
      const sitesData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Site[];
      setSites(sitesData);
    });

    const unsubscribeUsers = onSnapshot(collection(db, 'users'), (snapshot) => {
      const usersData = snapshot.docs.map(d => ({
        ...d.data(),
        _docId: d.id, // lưu document ID thực để dùng khi xóa/update
      })) as (UserProfile & { _docId: string })[];
      setUsers(usersData);
      setLoading(false);
    });

    const requestsQuery = query(collection(db, 'requests'), orderBy('createdAt', 'desc'));
    const unsubscribeRequests = onSnapshot(requestsQuery, (snapshot) => {
      const reqData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as WorkRequest[];
      setRequests(reqData);
    });

    return () => {
      unsubscribeSites();
      unsubscribeUsers();
      unsubscribeRequests();
    };
  }, [isAdmin, isManager]);

  const totalSitePages = Math.ceil(sites.length / ITEMS_PER_PAGE);
  const paginatedSites = sites.slice((sitesPage - 1) * ITEMS_PER_PAGE, sitesPage * ITEMS_PER_PAGE);

  const filteredUsers = users.filter(user => {
    // Nếu là manager, chỉ hiện nhân viên thuộc quyền quản lý (so sánh không phân biệt hoa/thường)
    if (!isAdmin && isManager) {
      const currentEmail = auth.currentUser?.email?.toLowerCase() ?? '';
      if ((user.managerEmail || '').toLowerCase() !== currentEmail) {
        return false;
      }
    }
    const q = userSearch.toLowerCase();
    const matchesSearch = (user.fullName || '').toLowerCase().includes(q) ||
                          (user.displayName || '').toLowerCase().includes(q) ||
                          (user.email || '').toLowerCase().includes(q) ||
                          (user.employeeCode || '').toLowerCase().includes(q);
    const matchesFilter = userFilter === 'all' || 
                          (userFilter === 'verified' && user.verified === true) || 
                          (userFilter === 'unverified' && user.verified === false);
    return matchesSearch && matchesFilter;
  });

  const totalUserPages = Math.ceil(filteredUsers.length / ITEMS_PER_PAGE);
  const paginatedUsers = filteredUsers.slice((usersPage - 1) * ITEMS_PER_PAGE, usersPage * ITEMS_PER_PAGE);

  useEffect(() => {
    if (sitesPage > totalSitePages && totalSitePages > 0) setSitesPage(totalSitePages);
  }, [sites.length, totalSitePages, sitesPage]);

  useEffect(() => {
    if (usersPage > totalUserPages && totalUserPages > 0) setUsersPage(totalUserPages);
  }, [filteredUsers.length, totalUserPages, usersPage]);

  const filteredRequests = requests.filter(req => {
    if (isAdmin) return true;
    if (isManager) {
      const currentEmail = auth.currentUser?.email?.toLowerCase() ?? '';
      // Dùng managerEmail lưu trực tiếp trên request (đáng tin hơn)
      if (req.managerEmail) {
        return req.managerEmail.toLowerCase() === currentEmail;
      }
      // Fallback: tìm qua danh sách user
      const requestUser = users.find(u => u.uid === req.userId);
      return (requestUser?.managerEmail || '').toLowerCase() === currentEmail;
    }
    return false;
  });

  // --- Cấu hình loại đề xuất (dùng cho hiển thị) ---
  const REQUEST_TYPE_LABELS: Record<WorkRequestType, { label: string; color: string; textColor: string; bgColor: string }> = {
    leave:          { label: 'Nghỉ phép',     color: 'border-blue-500',   textColor: 'text-blue-700',   bgColor: 'bg-blue-50'   },
    overtime:       { label: 'Tăng ca',        color: 'border-purple-500', textColor: 'text-purple-700', bgColor: 'bg-purple-50' },
    late:           { label: 'Đi muộn',        color: 'border-amber-500',  textColor: 'text-amber-700',  bgColor: 'bg-amber-50'  },
    early_leave:    { label: 'Về sớm',         color: 'border-orange-500', textColor: 'text-orange-700', bgColor: 'bg-orange-50' },
    forgot_checkin: { label: 'Quên check-in',  color: 'border-rose-500',   textColor: 'text-rose-700',   bgColor: 'bg-rose-50'   },
    forgot_checkout:{ label: 'Quên check-out', color: 'border-teal-500',   textColor: 'text-teal-700',   bgColor: 'bg-teal-50'   },
    sunday_holiday: { label: 'Làm CN/Lễ',     color: 'border-green-500',  textColor: 'text-green-700',  bgColor: 'bg-green-50'  },
  };

  // Helper: fullName > userName
  const getRequesterName = (req: WorkRequest) =>
    req.fullName || users.find(u => u.uid === req.userId)?.fullName || req.userName || 'Không rõ';

  // Nhóm requests theo ngày gửi rồi theo loại
  type ReqGroup = { dateKey: string; dateLabel: string; ts: number; byType: Map<WorkRequestType, WorkRequest[]> };
  const groupedRequests = useMemo<ReqGroup[]>(() => {
    const dateMap = new Map<string, ReqGroup>();
    for (const req of filteredRequests) {
      const d = new Date(req.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!dateMap.has(key)) {
        dateMap.set(key, {
          dateKey: key,
          dateLabel: d.toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }),
          ts: req.createdAt,
          byType: new Map(),
        });
      }
      const g = dateMap.get(key)!;
      const t = (req.type as WorkRequestType) || 'leave';
      if (!g.byType.has(t)) g.byType.set(t, []);
      g.byType.get(t)!.push(req);
    }
    return Array.from(dateMap.values()).sort((a, b) => b.ts - a.ts);
  }, [filteredRequests, users]);

  const handleAddSite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSite.name || !newSite.latitude || !newSite.longitude || !newSite.radius) return;

    setIsAdding(true);
    try {
      let imageUrl = '';
      if (newSiteImage) {
        const imageRef = ref(storage, `sites/${Date.now()}_${newSiteImage.name}`);
        await uploadBytes(imageRef, newSiteImage);
        imageUrl = await getDownloadURL(imageRef);
      }

      const docRef = await addDoc(collection(db, 'sites'), {
        name: newSite.name,
        latitude: parseFloat(newSite.latitude),
        longitude: parseFloat(newSite.longitude),
        radius: parseInt(newSite.radius, 10),
        checkInTime: newSite.checkInTime,
        checkOutTime: newSite.checkOutTime,
        ...(imageUrl && { imageUrl })
      });

      // Sync to Lark
      syncToLark('sites', {
        "ID": docRef.id,
        "Tên công trường": newSite.name,
        "Vĩ độ": parseFloat(newSite.latitude),
        "Kinh độ": parseFloat(newSite.longitude),
        "Bán kính": parseInt(newSite.radius, 10),
        "Giờ vào": newSite.checkInTime,
        "Giờ ra": newSite.checkOutTime,
        "Ảnh": imageUrl
      });

      invalidateSitesCache();
      setNewSite({ name: '', latitude: '', longitude: '', radius: '100', checkInTime: '07:30', checkOutTime: '17:30' });
      setNewSiteImage(null);
    } catch (error) {
      console.error("Error adding site:", error);
      alert("Lỗi khi thêm địa điểm.");
    } finally {
      setIsAdding(false);
    }
  };

  const handleDeleteSite = async (id: string) => {
    if (window.confirm('Bạn có chắc chắn muốn xóa địa điểm này?')) {
      try {
        await deleteDoc(doc(db, 'sites', id));
        invalidateSitesCache();
      } catch (error) {
        console.error("Error deleting site:", error);
        alert("Lỗi khi xóa địa điểm.");
      }
    }
  };

  const handleUpdateSite = async (id: string) => {
    if (!editSiteData.name || !editSiteData.latitude || !editSiteData.longitude || !editSiteData.radius) return;
    setIsUploadingImage(true);
    try {
      let imageUrl = editSiteData.imageUrl;
      if (editSiteImage) {
        const imageRef = ref(storage, `sites/${Date.now()}_${editSiteImage.name}`);
        await uploadBytes(imageRef, editSiteImage);
        imageUrl = await getDownloadURL(imageRef);
      }

      await updateDoc(doc(db, 'sites', id), {
        name: editSiteData.name,
        latitude: typeof editSiteData.latitude === 'string' ? parseFloat(editSiteData.latitude) : editSiteData.latitude,
        longitude: typeof editSiteData.longitude === 'string' ? parseFloat(editSiteData.longitude) : editSiteData.longitude,
        radius: typeof editSiteData.radius === 'string' ? parseInt(editSiteData.radius as any, 10) : editSiteData.radius,
        checkInTime: editSiteData.checkInTime || '07:30',
        checkOutTime: editSiteData.checkOutTime || '17:30',
        ...(imageUrl && { imageUrl })
      });

      // Sync to Lark
      syncToLark('sites', {
        "ID": id,
        "Tên công trường": editSiteData.name,
        "Vĩ độ": typeof editSiteData.latitude === 'string' ? parseFloat(editSiteData.latitude) : editSiteData.latitude,
        "Kinh độ": typeof editSiteData.longitude === 'string' ? parseFloat(editSiteData.longitude) : editSiteData.longitude,
        "Bán kính": typeof editSiteData.radius === 'string' ? parseInt(editSiteData.radius as any, 10) : editSiteData.radius,
        "Giờ vào": editSiteData.checkInTime || '07:30',
        "Giờ ra": editSiteData.checkOutTime || '17:30',
        "Ảnh": imageUrl
      });

      invalidateSitesCache();
      setEditingSiteId(null);
      setEditSiteImage(null);
    } catch (error) {
      console.error("Error updating site:", error);
      alert("Lỗi khi cập nhật địa điểm.");
    } finally {
      setIsUploadingImage(false);
    }
  };

  const handleSiteRoleChange = async (userId: string, siteId: string, newRole: string, currentAssigned: string[] = [], currentRoles: Record<string, string> = {}) => {
    let newAssigned = [...currentAssigned];
    const newRoles = { ...currentRoles };

    if (newRole === 'none') {
      newAssigned = newAssigned.filter(id => id !== siteId);
      delete newRoles[siteId];
    } else {
      if (!newAssigned.includes(siteId)) {
        newAssigned.push(siteId);
      }
      newRoles[siteId] = newRole;
    }

    try {
      await updateDoc(doc(db, 'users', userId), {
        assignedSiteIds: newAssigned,
        siteRoles: newRoles
      });
    } catch (error) {
      console.error("Error updating user site role:", error);
      alert("Lỗi khi cập nhật phân công.");
    }
  };

  const handleBatchAssign = async (userId: string, action: 'all_worker' | 'all_view' | 'none') => {
    const newAssigned: string[] = [];
    const newRoles: Record<string, string> = {};

    if (action !== 'none') {
      const role = action === 'all_worker' ? 'worker' : 'view_only';
      sites.forEach(site => {
        newAssigned.push(site.id);
        newRoles[site.id] = role;
      });
    }

    try {
      await updateDoc(doc(db, 'users', userId), {
        assignedSiteIds: newAssigned,
        siteRoles: newRoles
      });
    } catch (error) {
      console.error("Error batch updating user sites:", error);
      alert("Lỗi khi cập nhật phân công hàng loạt.");
    }
  };

  const handleRoleChange = async (userId: string, newRole: string) => {
    try {
      await updateDoc(doc(db, 'users', userId), {
        role: newRole
      });
      
      // Sync to Lark
      const user = users.find(u => u.uid === userId);
      if (user) {
        syncToLark('users', {
          "ID": userId,
          "Tên": user.displayName || user.email,
          "Email": user.email,
          "Vai trò": newRole,
          "Trạng thái": user.verified ? 'Đã xác thực' : 'Chưa xác thực'
        });
      }
    } catch (error) {
      console.error("Error updating user role:", error);
      alert("Lỗi khi cập nhật vai trò.");
    }
  };

  const handleManagerUpdate = async (userId: string, managerName: string, managerEmail: string) => {
    try {
      // Tìm UID của manager từ danh sách users (để lưu managerId dùng trong Firestore rules)
      const managerUser = users.find(u => (u.email || '').toLowerCase() === managerEmail.toLowerCase());
      const managerUid = managerUser?.uid || '';

      await updateDoc(doc(db, 'users', userId), {
        managerName,
        managerEmail,
        managerUid,
      });
      
      // Sync to Lark
      const user = users.find(u => u.uid === userId);
      if (user) {
        syncToLark('users', {
          "ID": userId,
          "Tên": user.displayName || user.email,
          "Email": user.email,
          "Vai trò": user.role,
          "Trạng thái": user.verified ? 'Đã xác thực' : 'Chưa xác thực',
          "Người quản lý": managerName,
          "Email người quản lý": managerEmail
        });
      }
    } catch (error) {
      console.error("Error updating manager:", error);
      alert("Lỗi khi cập nhật người quản lý.");
    }
  };

  const handleToggleVerification = async (userId: string, currentStatus: boolean) => {
    try {
      await updateDoc(doc(db, 'users', userId), {
        verified: !currentStatus
      });

      // Sync to Lark
      const user = users.find(u => u.uid === userId);
      if (user) {
        syncToLark('users', {
          "ID": userId,
          "Tên": user.displayName || user.email,
          "Email": user.email,
          "Vai trò": user.role,
          "Trạng thái": !currentStatus ? 'Đã xác thực' : 'Chưa xác thực'
        });
      }
    } catch (error) {
      console.error("Error toggling user verification:", error);
      alert("Lỗi khi cập nhật trạng thái xác thực.");
    }
  };

  const handleUpdateUserInfo = async (userId: string, displayName: string, email: string, employeeCode: string, fullName?: string) => {
    try {
      await updateDoc(doc(db, 'users', userId), { displayName, email, employeeCode, fullName: fullName || '' });

      // Sync to Lark
      const user = users.find(u => u.uid === userId);
      if (user) {
        syncToLark('users', {
          "ID": userId,
          "Mã NV": employeeCode,
          "Họ và tên": fullName || '',
          "Tên": displayName || email,
          "Email": email,
          "Vai trò": user.role,
          "Trạng thái": user.verified ? 'Đã xác thực' : 'Chưa xác thực'
        });
      }
    } catch (error) {
      console.error("Error updating user info:", error);
      alert("Lỗi khi cập nhật thông tin nhân viên.");
    }
  };

  const handleDeleteUser = async (userId: string, userName: string) => {
    if (!window.confirm(`Xóa nhân viên "${userName}" khỏi hệ thống?\n\nLưu ý: Tài khoản đăng nhập vẫn còn tồn tại, chỉ xóa dữ liệu nhân sự.`)) return;
    try {
      // Dùng document ID thực (_docId) thay vì uid field
      const userObj = users.find(u => u.uid === userId) as any;
      const docId = userObj?._docId || userId;
      console.log('[deleteUser] docId:', docId, '| uid field:', userId, '| same:', docId === userId);
      await deleteDoc(doc(db, 'users', docId));
    } catch (error: any) {
      console.error("Error deleting user:", error?.code, error?.message, error);
      alert(`Lỗi khi xóa nhân viên: ${error?.code || error?.message || 'Không xác định'}`);
    }
  };

  const handleUpdateRequestStatus = async (requestId: string, status: 'approved' | 'rejected') => {
    try {
      await updateDoc(doc(db, 'requests', requestId), { status });
      // eslint-disable-next-line no-console
      
      // Sync to Lark
      const request = requests.find(r => r.id === requestId);
      if (request) {
        syncToLark('requests', {
          "ID": requestId,
          "Nhân viên": request.fullName || users.find(u => u.uid === request.userId)?.fullName || request.userName || 'Unknown',
          "Loại": REQUEST_TYPE_LABELS[request.type as WorkRequestType]?.label ?? request.type,
          "Từ": request.date,
          "Đến": request.endDate || request.date,
          "Giờ bắt đầu": request.startTime || '',
          "Giờ kết thúc": request.endTime || '',
          "Lý do": request.reason,
          "Trạng thái": status === 'approved' ? 'Đã duyệt' : 'Từ chối'
        });
      }
    } catch (err: any) {
      console.error("Error updating request status:", err?.code, err?.message, err);
      alert(`Lỗi khi cập nhật trạng thái đề xuất.\nCode: ${err?.code || 'unknown'}\n${err?.message || ''}`);
    }
  };

  const handleDebugLark = async () => {
    setLarkDebugStatus({ loading: true, result: null });
    try {
      const response = await fetch('/api/sync/lark/debug');
      const data = await response.json();
      setLarkDebugStatus({ loading: false, result: data });
    } catch (err: any) {
      setLarkDebugStatus({ loading: false, result: { error: err.message } });
    }
  };

  const handleBulkSync = async (type: LarkSyncType) => {
    setBulkSyncStatus(prev => ({ ...prev, [type]: { loading: true, success: 0, failed: 0, total: 0, done: false } }));

    try {
      let records: any[] = [];

      if (type === 'attendance') {
        // Chỉ lấy records trong khoảng date range — tránh đọc toàn bộ collection
        const fromTs = new Date(syncDateFrom).setHours(0, 0, 0, 0);
        const toTs = new Date(syncDateTo).setHours(23, 59, 59, 999);
        const attendanceQuery = query(
          collection(db, 'attendance'),
          where('timestamp', '>=', fromTs),
          where('timestamp', '<=', toTs),
          orderBy('timestamp', 'asc')
        );
        const snapshot = await getDocs(attendanceQuery);
        const allRecords = snapshot.docs.map(d => ({ id: d.id, ...d.data() })) as (AttendanceRecord & { id: string })[];

        // Gộp check-in/check-out theo userId + ngày
        const groups = new Map<string, { checkIn?: AttendanceRecord & { id: string }; checkOut?: AttendanceRecord & { id: string } }>();
        for (const record of allRecords) {
          const startOfDay = new Date(record.timestamp);
          startOfDay.setHours(0, 0, 0, 0);
          const key = `${record.userId}_${startOfDay.getTime()}`;
          if (!groups.has(key)) groups.set(key, {});
          const group = groups.get(key)!;
          if (record.type === 'check-in') {
            if (!group.checkIn || record.timestamp < group.checkIn.timestamp) group.checkIn = record;
          } else {
            if (!group.checkOut || record.timestamp > group.checkOut.timestamp) group.checkOut = record;
          }
        }

        for (const [key, group] of groups.entries()) {
          const rep = group.checkIn ?? group.checkOut;
          if (!rep) continue;
          const syncData: any = {
            "ID": key,
            "Nhân viên": rep.userName,
            "Thời gian": rep.timestamp,
            "Công trường": rep.siteName,
            "Vĩ độ": rep.location.latitude,
            "Kinh độ": rep.location.longitude,
          };
          if (group.checkIn) {
            syncData["Giờ vào"] = group.checkIn.timestamp;
            syncData["Ảnh vào"] = group.checkIn.photoUrl;
            syncData["Ảnh"] = group.checkIn.photoUrl;
          }
          if (group.checkOut) {
            syncData["Giờ ra"] = group.checkOut.timestamp;
            syncData["Ảnh ra"] = group.checkOut.photoUrl;
            if (!group.checkIn) syncData["Ảnh"] = group.checkOut.photoUrl;
          }
          records.push(syncData);
        }

      } else if (type === 'users') {
        records = users.map(u => ({
          "ID": u.uid,
          "Tên": u.displayName || u.email,
          "Email": u.email,
          "Vai trò": u.role,
          "Trạng thái": u.verified ? 'Đã xác thực' : 'Chưa xác thực',
          "Người quản lý": u.managerName || '',
          "Email người quản lý": u.managerEmail || '',
        }));

      } else if (type === 'sites') {
        records = sites.map(s => ({
          "ID": s.id,
          "Tên công trường": s.name,
          "Vĩ độ": s.latitude,
          "Kinh độ": s.longitude,
          "Bán kính": s.radius,
          "Giờ vào": s.checkInTime || '',
          "Giờ ra": s.checkOutTime || '',
          "Ảnh": s.imageUrl || '',
        }));

      } else if (type === 'requests') {
        records = requests.map(r => ({
          "ID": r.id,
          "Nhân viên": r.fullName || users.find(u => u.uid === r.userId)?.fullName || r.userName,
          "Loại": REQUEST_TYPE_LABELS[r.type as WorkRequestType]?.label ?? r.type,
          "Từ": r.date,
          "Đến": r.endDate || r.date,
          "Giờ bắt đầu": r.startTime || '',
          "Giờ kết thúc": r.endTime || '',
          "Lý do": r.reason,
          "Trạng thái": r.status === 'approved' ? 'Đã duyệt' : r.status === 'rejected' ? 'Từ chối' : 'Chờ duyệt',
        }));
      }

      setBulkSyncStatus(prev => ({ ...prev, [type]: { ...prev[type], total: records.length } }));

      const result = await bulkSyncToLark(type, records);
      setBulkSyncStatus(prev => ({
        ...prev,
        [type]: {
          loading: false,
          success: result?.success ?? 0,
          failed: result?.failed ?? records.length,
          total: result?.total ?? records.length,
          done: true,
        },
      }));
    } catch (err) {
      console.error(`Bulk sync error for ${type}:`, err);
      setBulkSyncStatus(prev => ({ ...prev, [type]: { ...prev[type], loading: false, done: true } }));
    }
  };

  const handleTestLark = async () => {
    setLarkTestStatus({ loading: true, result: null, error: null });
    try {
      const response = await fetch('/api/sync/lark/test', { method: 'GET' });
      const data = await response.json();
      if (response.ok) {
        setLarkTestStatus({ loading: false, result: data, error: null });
      } else {
        setLarkTestStatus({ loading: false, result: null, error: data.error || 'Lỗi không xác định' });
      }
    } catch (err: any) {
      setLarkTestStatus({ loading: false, result: null, error: err.message });
    }
  };

  if (!isAdmin && !isManager) {
    return (
      <div className="p-8 m-4 text-center space-y-4 bg-white rounded-3xl shadow-sm border border-red-100">
        <div className="w-20 h-20 bg-red-50 rounded-full flex items-center justify-center mx-auto text-red-500">
          <AlertTriangle size={40} />
        </div>
        <p className="text-red-600 font-bold text-lg">Truy cập bị từ chối</p>
        <p className="text-gray-500 text-sm">Bạn không có quyền quản trị viên hoặc quản lý để xem trang này.</p>
      </div>
    );
  }

  if (loading) {
    return <div className="p-8 text-center text-gray-500">Đang tải dữ liệu...</div>;
  }

  return (
    <div className="p-4 space-y-6">
      <div className="flex bg-gray-200 p-1 rounded-2xl overflow-x-auto scrollbar-hide shrink-0">
        {isAdmin && (
          <button
            onClick={() => setActiveTab('sites')}
            className={cn(
              "flex-1 py-3 px-4 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all whitespace-nowrap",
              activeTab === 'sites' ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
            )}
          >
            <Building2 size={18} />
            Công trường
          </button>
        )}
        <button
          onClick={() => setActiveTab('users')}
          className={cn(
            "flex-1 py-3 px-4 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all whitespace-nowrap",
            activeTab === 'users' ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
          )}
        >
          <Users size={18} />
          Nhân sự
        </button>
        <button
          onClick={() => setActiveTab('requests')}
          className={cn(
            "flex-1 py-3 px-4 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all relative whitespace-nowrap",
            activeTab === 'requests' ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
          )}
        >
          <FileText size={18} />
          Đề xuất
          {filteredRequests.filter(r => r.status === 'pending').length > 0 && (
            <span className="absolute top-1 right-2 bg-red-500 text-white text-[10px] w-4 h-4 rounded-full flex items-center justify-center font-bold">
              {filteredRequests.filter(r => r.status === 'pending').length}
            </span>
          )}
        </button>
        {isAdmin && (
          <button
            onClick={() => setActiveTab('settings')}
            className={cn(
              "flex-1 py-3 px-4 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all whitespace-nowrap",
              activeTab === 'settings' ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
            )}
          >
            <Settings size={18} />
            Cài đặt
          </button>
        )}
      </div>

      {activeTab === 'sites' && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div className="bg-white p-6 rounded-3xl shadow-sm border border-gray-100">
            <h2 className="text-xl font-black text-gray-900 uppercase tracking-tighter mb-4 flex items-center gap-2">
              <Plus size={24} className="text-blue-600" />
              Thêm địa điểm mới
            </h2>
            
            <form onSubmit={handleAddSite} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-1">Tên công trường</label>
                <input
                  type="text"
                  value={newSite.name}
                  onChange={(e) => setNewSite({...newSite, name: e.target.value})}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="VD: Landmark 81"
                  required
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-1">Vĩ độ (Latitude)</label>
                  <input
                    type="number"
                    step="any"
                    value={newSite.latitude}
                    onChange={(e) => setNewSite({...newSite, latitude: e.target.value})}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="10.7948"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-1">Kinh độ (Longitude)</label>
                  <input
                    type="number"
                    step="any"
                    value={newSite.longitude}
                    onChange={(e) => setNewSite({...newSite, longitude: e.target.value})}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="106.7218"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-1">Giờ vào ca</label>
                  <input
                    type="time"
                    value={newSite.checkInTime}
                    onChange={(e) => setNewSite({...newSite, checkInTime: e.target.value})}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-1">Giờ ra ca</label>
                  <input
                    type="time"
                    value={newSite.checkOutTime}
                    onChange={(e) => setNewSite({...newSite, checkOutTime: e.target.value})}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-1">Bán kính cho phép (mét)</label>
                  <input
                    type="number"
                    value={newSite.radius}
                    onChange={(e) => setNewSite({...newSite, radius: e.target.value})}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="100"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-1">Hình ảnh đại diện</label>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => setNewSiteImage(e.target.files?.[0] || null)}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm file:mr-4 file:py-1 file:px-3 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isAdding}
                className="w-full bg-blue-600 text-white rounded-xl py-4 font-bold uppercase tracking-widest hover:bg-blue-700 active:scale-95 transition-all flex items-center justify-center gap-2"
              >
                {isAdding ? <Loader2 size={20} className="animate-spin" /> : "Thêm công trường"}
              </button>
            </form>
          </div>

          <div className="space-y-4">
            <h3 className="text-sm font-black text-gray-400 uppercase tracking-widest px-2">
              Danh sách công trường ({sites.length})
            </h3>
            
            {sites.length === 0 ? (
              <div className="text-center p-8 text-gray-500 bg-white rounded-2xl border border-dashed border-gray-300">
                Chưa có địa điểm nào.
              </div>
            ) : (
              <div className="space-y-3">
                {paginatedSites.map(site => (
                  editingSiteId === site.id ? (
                    <div key={site.id} className="bg-blue-50 p-4 rounded-2xl shadow-sm border border-blue-100 space-y-3">
                      <div>
                        <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Tên công trường</label>
                        <input type="text" value={editSiteData.name || ''} onChange={(e) => setEditSiteData({...editSiteData, name: e.target.value})} className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Vĩ độ</label>
                          <input type="number" step="any" value={editSiteData.latitude || ''} onChange={(e) => setEditSiteData({...editSiteData, latitude: e.target.value})} className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Kinh độ</label>
                          <input type="number" step="any" value={editSiteData.longitude || ''} onChange={(e) => setEditSiteData({...editSiteData, longitude: e.target.value})} className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Giờ vào</label>
                          <input type="time" value={editSiteData.checkInTime || ''} onChange={(e) => setEditSiteData({...editSiteData, checkInTime: e.target.value})} className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Giờ ra</label>
                          <input type="time" value={editSiteData.checkOutTime || ''} onChange={(e) => setEditSiteData({...editSiteData, checkOutTime: e.target.value})} className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Bán kính (m)</label>
                        <input type="number" value={editSiteData.radius || ''} onChange={(e) => setEditSiteData({...editSiteData, radius: e.target.value})} className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Hình ảnh đại diện (Tùy chọn)</label>
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => setEditSiteImage(e.target.files?.[0] || null)}
                          className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 file:mr-4 file:py-1 file:px-3 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                        />
                      </div>
                      <div className="flex gap-2 pt-2">
                        <button onClick={() => { setEditingSiteId(null); setEditSiteImage(null); }} className="flex-1 bg-gray-200 text-gray-700 rounded-lg py-2 text-sm font-bold hover:bg-gray-300 transition-colors flex items-center justify-center gap-2">
                          <X size={16} /> Hủy
                        </button>
                        <button disabled={isUploadingImage} onClick={() => handleUpdateSite(site.id)} className="flex-1 bg-blue-600 text-white rounded-lg py-2 text-sm font-bold hover:bg-blue-700 transition-colors flex items-center justify-center gap-2">
                          {isUploadingImage ? <Loader2 size={16} className="animate-spin" /> : <><Save size={16} /> Lưu</>}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div key={site.id} className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex items-center justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-3">
                          {site.imageUrl ? (
                            <div className="w-8 h-8 rounded-lg overflow-hidden shrink-0 border border-gray-200 shadow-sm">
                              <img src={site.imageUrl} alt={site.name} className="w-full h-full object-cover" />
                            </div>
                          ) : (
                            <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center shrink-0 border border-gray-200 text-gray-400">
                              <ImageIcon size={14} />
                            </div>
                          )}
                          <div className="flex items-center gap-2">
                            <h4 className="font-bold text-gray-900">{site.name}</h4>
                            {site.imageUrl && (
                              <span className="flex items-center gap-1 px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-[10px] font-bold uppercase tracking-wider">
                                <Check size={10} /> Có ảnh
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-gray-500 mt-2 pl-11">
                          <span className="flex items-center gap-1 font-mono"><MapPin size={12} /> {site.latitude}, {site.longitude}</span>
                          <span className="flex items-center gap-1"><Clock size={12} /> {site.checkInTime || '07:30'} - {site.checkOutTime || '17:30'}</span>
                        </div>
                        <p className="text-xs text-blue-600 font-medium mt-1 pl-11">
                          Bán kính: {site.radius}m
                        </p>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <button
                          onClick={() => { setEditingSiteId(site.id); setEditSiteData(site); }}
                          className="p-2 text-blue-500 hover:bg-blue-50 rounded-lg transition-colors"
                        >
                          <Edit2 size={20} />
                        </button>
                        <button
                          onClick={() => handleDeleteSite(site.id)}
                          className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                        >
                          <Trash2 size={20} />
                        </button>
                      </div>
                    </div>
                  )
                ))}
              </div>
            )}

            {totalSitePages > 1 && (
              <div className="flex items-center justify-between mt-4 bg-white p-3 rounded-2xl border border-gray-100 shadow-sm">
                <button
                  onClick={() => setSitesPage(p => Math.max(1, p - 1))}
                  disabled={sitesPage === 1}
                  className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed text-gray-600 transition-colors"
                >
                  <ChevronLeft size={20} />
                </button>
                <span className="text-sm font-bold text-gray-600">
                  Trang {sitesPage} / {totalSitePages}
                </span>
                <button
                  onClick={() => setSitesPage(p => Math.min(totalSitePages, p + 1))}
                  disabled={sitesPage === totalSitePages}
                  className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed text-gray-600 transition-colors"
                >
                  <ChevronRight size={20} />
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'users' && (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div className="flex flex-col sm:flex-row gap-3 px-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
              <input
                type="text"
                placeholder="Tìm kiếm nhân sự..."
                value={userSearch}
                onChange={(e) => { setUserSearch(e.target.value); setUsersPage(1); }}
                className="w-full bg-white border border-gray-200 rounded-xl pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-3 py-2">
              <Filter size={16} className="text-gray-400" />
              <select
                value={userFilter}
                onChange={(e) => { setUserFilter(e.target.value as any); setUsersPage(1); }}
                className="bg-transparent text-sm font-medium focus:outline-none cursor-pointer"
              >
                <option value="all">Tất cả</option>
                <option value="verified">Đã xác thực</option>
                <option value="unverified">Chờ xác thực</option>
              </select>
            </div>
          </div>

          <h3 className="text-sm font-black text-gray-400 uppercase tracking-widest px-2">
            Danh sách nhân sự ({filteredUsers.length})
          </h3>
          
          <div className="overflow-x-auto bg-white rounded-2xl shadow-sm border border-gray-100">
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-gray-50 border-b border-gray-100 text-xs font-bold text-gray-500 uppercase tracking-wider">
                <tr>
                  <th className="p-4">Nhân viên</th>
                  <th className="p-4">Người quản lý</th>
                  <th className="p-4">Vai trò</th>
                  <th className="p-4">Trạng thái</th>
                  <th className="p-4">Phân công</th>
                  {isAdmin && <th className="p-4">Hành động</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {paginatedUsers.map(user => (
                  <UserTableRow
                    key={user.uid}
                    user={user}
                    sites={sites}
                    isAdmin={!!isAdmin}
                    handleToggleVerification={handleToggleVerification}
                    handleRoleChange={handleRoleChange}
                    handleManagerUpdate={handleManagerUpdate}
                    handleSiteRoleChange={handleSiteRoleChange}
                    handleBatchAssign={handleBatchAssign}
                    handleUpdateUserInfo={handleUpdateUserInfo}
                    handleDeleteUser={handleDeleteUser}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {totalUserPages > 1 && (
            <div className="flex items-center justify-between mt-4 bg-white p-3 rounded-2xl border border-gray-100 shadow-sm">
              <button
                onClick={() => setUsersPage(p => Math.max(1, p - 1))}
                disabled={usersPage === 1}
                className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed text-gray-600 transition-colors"
              >
                <ChevronLeft size={20} />
              </button>
              <span className="text-sm font-bold text-gray-600">
                Trang {usersPage} / {totalUserPages}
              </span>
              <button
                onClick={() => setUsersPage(p => Math.min(totalUserPages, p + 1))}
                disabled={usersPage === totalUserPages}
                className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed text-gray-600 transition-colors"
              >
                <ChevronRight size={20} />
              </button>
            </div>
          )}
        </div>
      )}

      {activeTab === 'requests' && (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-black text-gray-900 uppercase tracking-tighter">Quản lý đề xuất</h3>
            <span className="text-xs text-gray-400 font-medium">{filteredRequests.length} đề xuất</span>
          </div>

          {groupedRequests.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-[32px] border border-gray-100 shadow-sm">
              <FileText size={48} className="mx-auto text-gray-200 mb-4" />
              <p className="text-gray-500 font-medium">Chưa có đề xuất nào.</p>
            </div>
          ) : (
            <div className="space-y-6">
              {groupedRequests.map(group => (
                <div key={group.dateKey} className="space-y-3">
                  {/* Tiêu đề ngày */}
                  <div className="flex items-center gap-3">
                    <div className="h-px flex-1 bg-gray-200" />
                    <span className="text-xs font-bold text-gray-400 uppercase tracking-widest whitespace-nowrap">
                      {group.dateLabel}
                    </span>
                    <div className="h-px flex-1 bg-gray-200" />
                  </div>

                  {/* Nhóm theo loại */}
                  {Array.from(group.byType.entries()).map(([reqType, reqs]) => {
                    const typeMeta = REQUEST_TYPE_LABELS[reqType] ?? REQUEST_TYPE_LABELS['leave'];
                    return (
                      <div key={reqType} className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
                        {/* Header loại */}
                        <div className={cn('px-5 py-3 flex items-center gap-2', typeMeta.bgColor)}>
                          <span className={cn('font-bold text-sm', typeMeta.textColor)}>{typeMeta.label}</span>
                          <span className={cn('ml-auto text-xs font-bold px-2 py-0.5 rounded-full', typeMeta.bgColor, typeMeta.textColor, 'border', typeMeta.color)}>
                            {reqs.length}
                          </span>
                        </div>

                        {/* Danh sách requests trong nhóm */}
                        <div className="divide-y divide-gray-50">
                          {reqs.map(req => (
                            <div key={req.id} className="p-4 space-y-3">
                              <div className="flex justify-between items-start">
                                <div className="flex items-center gap-3">
                                  <div className="w-9 h-9 bg-gray-100 rounded-xl flex items-center justify-center text-gray-600 shrink-0">
                                    <User size={18} />
                                  </div>
                                  <div>
                                    <h4 className="font-bold text-gray-900 text-sm">{getRequesterName(req)}</h4>
                                    <p className="text-xs text-gray-500 font-medium">
                                      {req.type === 'leave'
                                        ? `${req.date.split('-').reverse().join('/')}${req.endDate ? ` → ${req.endDate.split('-').reverse().join('/')}` : ''}`
                                        : req.startTime && req.endTime
                                          ? `${req.date.split('-').reverse().join('/')} (${req.startTime} – ${req.endTime})`
                                          : req.date.split('-').reverse().join('/')
                                      }
                                    </p>
                                  </div>
                                </div>
                                {req.status === 'pending' ? (
                                  <span className="px-2 py-1 bg-amber-100 text-amber-700 rounded-full text-[10px] font-bold uppercase tracking-widest flex items-center gap-1 shrink-0">
                                    <Clock size={12} /> Chờ duyệt
                                  </span>
                                ) : req.status === 'approved' ? (
                                  <span className="px-2 py-1 bg-green-100 text-green-700 rounded-full text-[10px] font-bold uppercase tracking-widest flex items-center gap-1 shrink-0">
                                    <CheckCircle size={12} /> Đã duyệt
                                  </span>
                                ) : (
                                  <span className="px-2 py-1 bg-red-100 text-red-700 rounded-full text-[10px] font-bold uppercase tracking-widest flex items-center gap-1 shrink-0">
                                    <XCircle size={12} /> Từ chối
                                  </span>
                                )}
                              </div>

                              <div className="bg-gray-50 rounded-xl px-4 py-3 text-sm">
                                <span className="text-gray-500">Lý do: </span>
                                <span className="font-medium text-gray-900">{req.reason}</span>
                              </div>

                              {req.status === 'pending' && (
                                <div className="flex gap-3">
                                  <button
                                    onClick={() => handleUpdateRequestStatus(req.id!, 'approved')}
                                    className="flex-1 bg-green-100 text-green-700 py-2.5 rounded-xl font-bold text-sm hover:bg-green-200 transition-colors flex items-center justify-center gap-2"
                                  >
                                    <Check size={16} /> Phê duyệt
                                  </button>
                                  <button
                                    onClick={() => handleUpdateRequestStatus(req.id!, 'rejected')}
                                    className="flex-1 bg-red-100 text-red-700 py-2.5 rounded-xl font-bold text-sm hover:bg-red-200 transition-colors flex items-center justify-center gap-2"
                                  >
                                    <X size={16} /> Từ chối
                                  </button>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'settings' && (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <h3 className="font-black text-gray-900 uppercase tracking-tighter mb-4">Cài đặt hệ thống</h3>
          
          <div className="bg-white p-6 rounded-3xl shadow-sm border border-gray-100 space-y-6">
            <div>
              <h4 className="text-lg font-bold text-gray-900 flex items-center gap-2 mb-2">
                <Settings size={20} className="text-blue-600" />
                Đồng bộ Lark Base
              </h4>
              <p className="text-sm text-gray-500 mb-4">
                Kiểm tra kết nối và cấu hình Lark Base của bạn. Hệ thống sẽ thử lấy token và kiểm tra các bảng dữ liệu.
              </p>
              
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={handleTestLark}
                  disabled={larkTestStatus.loading}
                  className="px-6 py-3 bg-blue-600 text-white rounded-xl font-bold text-sm shadow-sm hover:bg-blue-700 active:scale-95 transition-all disabled:opacity-50 flex items-center gap-2"
                >
                  {larkTestStatus.loading ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle size={16} />}
                  {larkTestStatus.loading ? 'Đang kiểm tra...' : 'Kiểm tra kết nối'}
                </button>
                <button
                  onClick={handleDebugLark}
                  disabled={larkDebugStatus.loading}
                  className="px-6 py-3 bg-amber-500 text-white rounded-xl font-bold text-sm shadow-sm hover:bg-amber-600 active:scale-95 transition-all disabled:opacity-50 flex items-center gap-2"
                >
                  {larkDebugStatus.loading ? <Loader2 size={16} className="animate-spin" /> : <AlertTriangle size={16} />}
                  {larkDebugStatus.loading ? 'Đang chẩn đoán...' : 'Chẩn đoán lỗi'}
                </button>
              </div>

              {larkTestStatus.error && (
                <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-2xl">
                  <div className="flex items-center gap-2 text-red-700 font-bold mb-1">
                    <AlertTriangle size={18} />
                    Lỗi kết nối
                  </div>
                  <p className="text-sm text-red-600">{larkTestStatus.error}</p>
                  <div className="mt-3 text-xs text-red-500 bg-red-100/50 p-3 rounded-xl space-y-1">
                    <p className="font-bold">Vui lòng kiểm tra lại các biến môi trường trong AI Studio Settings:</p>
                    <ul className="list-disc pl-4 space-y-1">
                      <li>LARK_APP_ID</li>
                      <li>LARK_APP_SECRET</li>
                      <li>LARK_BASE_ID</li>
                      <li>LARK_TABLE_ATTENDANCE</li>
                      <li>LARK_TABLE_USERS</li>
                      <li>LARK_TABLE_SITES</li>
                      <li>LARK_TABLE_REQUESTS</li>
                    </ul>
                  </div>
                </div>
              )}

              {larkTestStatus.result && (
                <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-2xl">
                  <div className="flex items-center gap-2 text-green-700 font-bold mb-2">
                    <CheckCircle size={18} />
                    Kết nối thành công!
                  </div>
                  <div className="bg-white border border-green-100 rounded-xl p-3 overflow-x-auto">
                    <pre className="text-[10px] text-green-800 font-mono">
                      {JSON.stringify(larkTestStatus.result, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>

            {larkDebugStatus.result && (
              <div className="p-4 bg-gray-50 border border-gray-200 rounded-2xl">
                <p className="font-bold text-gray-700 mb-3 flex items-center gap-2">
                  <AlertTriangle size={16} className="text-amber-500" />
                  Kết quả chẩn đoán
                </p>
                {/* Env Vars */}
                <div className="mb-3">
                  <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Biến môi trường</p>
                  <div className="grid grid-cols-2 gap-1">
                    {larkDebugStatus.result.envVars && Object.entries(larkDebugStatus.result.envVars).map(([k, v]) => (
                      <div key={k} className="flex items-center gap-2 text-xs">
                        <span className={cn("w-2 h-2 rounded-full flex-shrink-0", v ? "bg-green-500" : "bg-red-500")} />
                        <span className={cn("font-mono", v ? "text-gray-700" : "text-red-600 font-bold")}>{k}</span>
                      </div>
                    ))}
                  </div>
                </div>
                {/* Token */}
                <div className="mb-3">
                  <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1">Lark Token</p>
                  <span className={cn(
                    "text-xs font-mono px-2 py-1 rounded-lg",
                    larkDebugStatus.result.tokenStatus === 'OK' ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                  )}>
                    {larkDebugStatus.result.tokenStatus}
                  </span>
                  {larkDebugStatus.result.tokenError && (
                    <p className="text-xs text-red-600 mt-1 font-mono">{JSON.stringify(larkDebugStatus.result.tokenError)}</p>
                  )}
                </div>
                {/* Table Check */}
                {larkDebugStatus.result.tableCheck && Object.keys(larkDebugStatus.result.tableCheck).length > 0 && (
                  <div>
                    <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Kiểm tra bảng</p>
                    <div className="space-y-1">
                      {Object.entries(larkDebugStatus.result.tableCheck).map(([name, status]) => (
                        <div key={name} className="flex items-center gap-2 text-xs">
                          <span className={cn("w-2 h-2 rounded-full flex-shrink-0", status === 'OK' ? "bg-green-500" : "bg-red-500")} />
                          <span className="font-medium text-gray-700 w-24">{name}</span>
                          <span className={cn("font-mono", status === 'OK' ? "text-green-700" : "text-red-600")}>{status as string}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="border-t border-gray-100 pt-6">
              <h4 className="text-lg font-bold text-gray-900 flex items-center gap-2 mb-2">
                <RefreshCw size={20} className="text-green-600" />
                Đồng bộ hàng loạt sang Lark Base
              </h4>
              <p className="text-sm text-gray-500 mb-4">
                Đồng bộ dữ liệu từng bảng lên Lark Base. Bản ghi đã có sẽ được cập nhật, bản ghi mới sẽ được thêm mới.
              </p>

              {/* Date range filter cho Chấm công */}
              <div className="bg-blue-50 border border-blue-100 rounded-2xl p-3 mb-4 space-y-2">
                <p className="text-xs font-bold text-blue-700 uppercase tracking-widest">Khoảng thời gian đồng bộ Chấm công</p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-gray-500 font-bold uppercase">Từ ngày</label>
                    <input
                      type="date"
                      value={syncDateFrom}
                      onChange={e => setSyncDateFrom(e.target.value)}
                      className="w-full mt-1 bg-white border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-500 font-bold uppercase">Đến ngày</label>
                    <input
                      type="date"
                      value={syncDateTo}
                      onChange={e => setSyncDateTo(e.target.value)}
                      className="w-full mt-1 bg-white border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                    />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {([
                  { type: 'attendance' as LarkSyncType, label: 'Chấm công', icon: Clock },
                  { type: 'users' as LarkSyncType, label: 'Nhân sự', icon: Users },
                  { type: 'sites' as LarkSyncType, label: 'Công trường', icon: Building2 },
                  { type: 'requests' as LarkSyncType, label: 'Đề xuất', icon: FileText },
                ]).map(({ type, label, icon: Icon }) => {
                  const status = bulkSyncStatus[type];
                  return (
                    <div key={type} className="bg-gray-50 border border-gray-200 rounded-2xl p-4 space-y-3">
                      <div className="flex items-center gap-2">
                        <Icon size={16} className="text-gray-500" />
                        <p className="font-bold text-gray-800 text-sm">{label}</p>
                      </div>
                      <button
                        onClick={() => handleBulkSync(type)}
                        disabled={status.loading}
                        className="w-full px-3 py-2.5 bg-green-600 text-white rounded-xl font-bold text-sm shadow-sm hover:bg-green-700 active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                      >
                        {status.loading
                          ? <Loader2 size={14} className="animate-spin" />
                          : <RefreshCw size={14} />
                        }
                        {status.loading
                          ? (status.total > 0 ? `${status.success + status.failed}/${status.total}` : 'Đang tải...')
                          : 'Đồng bộ tất cả'
                        }
                      </button>
                      {status.done && (
                        <div className={cn(
                          "text-xs px-3 py-2 rounded-xl font-medium",
                          status.failed === 0 ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"
                        )}>
                          ✓ {status.success} thành công
                          {status.failed > 0 && ` · ✗ ${status.failed} lỗi`}
                          {' · '}tổng {status.total}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
