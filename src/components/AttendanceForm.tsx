import React, { useState, useEffect, useCallback } from 'react';
import { MapPin, Camera, CheckCircle, AlertCircle, Loader2, LogIn, LogOut, RefreshCw, Clock } from 'lucide-react';
import { GEOLOCATION_OPTIONS, DEFAULT_ADMIN_EMAIL } from '../constants';
import { calculateDistance, formatTimestamp, cn } from '../lib/utils';
import { AttendanceRecord, Site, UserProfile } from '../types';
import { CameraComponent } from './CameraComponent';
import { auth, db, storage } from '../firebase';
import { collection, addDoc, serverTimestamp, getDocs, query, where, orderBy, limit, doc, getDoc } from 'firebase/firestore';
import { ref, uploadString, getDownloadURL } from 'firebase/storage';
import { syncToLark } from '../lib/larkSync';
import { getCachedSites } from '../lib/sitesCache';

interface PopupData {
  type: 'check-in' | 'check-out';
  status: 'success' | 'error';
  message: string;
  lateMinutes?: number;
  earlyMinutes?: number;
  workingHours?: { hours: number; minutes: number };
  lunchBreakMinutes?: number;
}

export const AttendanceForm: React.FC = () => {
  const [location, setLocation] = useState<GeolocationPosition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [isCameraOpen, setIsCameraOpen] = useState<boolean>(false);
  const [attendanceType, setAttendanceType] = useState<'check-in' | 'check-out' | null>(null);
  const [selectedSite, setSelectedSite] = useState<Site | null>(null);
  const [serverTime, setServerTime] = useState<number | null>(null);
  const [isOffline, setIsOffline] = useState<boolean>(!navigator.onLine);
  const [sites, setSites] = useState<Site[]>([]);
  const [popup, setPopup] = useState<PopupData | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [usingClientTime, setUsingClientTime] = useState<boolean>(false);

  useEffect(() => {
    const fetchSites = async () => {
      try {
        if (!auth.currentUser) return;

        // Fetch user profile to get assigned sites
        const userDocRef = doc(db, 'users', auth.currentUser!.uid);
        const userDocSnap = await getDoc(userDocRef);
        const currentUserProfile = userDocSnap.exists() ? userDocSnap.data() : null;
        setUserProfile(currentUserProfile);

        if (currentUserProfile && currentUserProfile.verified === false) {
          setError('Tài khoản của bạn chưa được xác thực. Vui lòng liên hệ Admin để được phê duyệt.');
          setSites([]);
          return;
        }

        const assignedSiteIds: string[] = currentUserProfile?.assignedSiteIds || [];
        const isAdmin = currentUserProfile?.role === 'admin' ||
          (auth.currentUser.email && auth.currentUser.email.toLowerCase() === DEFAULT_ADMIN_EMAIL);

        // Dùng module-level cache — tránh đọc lại Firestore mỗi lần chuyển tab
        let sitesData = await getCachedSites();

        // Admin thấy tất cả công trường; worker chỉ thấy công trường được phân công
        if (!isAdmin) {
          const siteRoles = currentUserProfile?.siteRoles || {};
          sitesData = sitesData.filter(site => {
            const isAssigned = assignedSiteIds.includes(site.id);
            // Chấp nhận nếu được assign mà không có siteRoles, hoặc có role 'worker'
            const role = siteRoles[site.id];
            return isAssigned && (role === undefined || role === 'worker');
          });
        }

        setSites(sitesData);
        if (sitesData.length === 0) {
          setError('Bạn chưa được phân công công trường nào. Vui lòng liên hệ Admin.');
        }
      } catch (err: unknown) {
        console.error("Error fetching sites:", err);
        // Hiển thị lỗi cụ thể thay vì im lặng — giúp debug khi quota Firestore hết
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
          setError('Hệ thống đang quá tải (quota). Vui lòng thử lại sau ít phút.');
        } else {
          setError('Không thể tải danh sách công trường. Kiểm tra kết nối mạng và thử lại.');
        }
      }
    };
    fetchSites();
  }, []);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const fetchServerTime = async (): Promise<number> => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch('/api/time', { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setServerTime(data.timestamp);
      return data.timestamp as number;
    } catch (err) {
      // Fallback về giờ client khi offline — ghi chú rõ để admin biết
      // Firestore serverTimestamp() vẫn sẽ ghi giờ server thực khi document được tạo
      console.warn('Server time unavailable, using client time. Firestore serverTimestamp will be authoritative.');
      const localTime = Date.now();
      setServerTime(localTime);
      setUsingClientTime(true);
      return localTime;
    }
  };

  const updateLocation = useCallback(() => {
    // Nếu sites chưa load xong, không check vị trí
    if (sites.length === 0) return;
    setLoading(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation(pos);
        setLoading(false);

        // Tìm công trường gần nhất
        let nearest: Site | null = null;
        let minDistance = Infinity;

        sites.forEach(site => {
          const dist = calculateDistance(
            pos.coords.latitude,
            pos.coords.longitude,
            site.latitude,
            site.longitude
          );
          if (dist < minDistance) {
            minDistance = dist;
            nearest = site;
          }
        });

        // Tính tolerance từ độ chính xác GPS (tối đa 50m)
        // Ví dụ: GPS accuracy = 30m → thêm 30m vào radius để tránh false-negative
        const gpsTolerance = Math.min(pos.coords.accuracy, 50);

        if (nearest && minDistance <= (nearest as Site).radius + gpsTolerance) {
          setSelectedSite(nearest);
        } else {
          setSelectedSite(null);
          const nearestName = nearest ? (nearest as Site).name : 'công trường';
          const distanceText = minDistance < Infinity ? ` (cách ${Math.round(minDistance)}m)` : '';
          setError(`Bạn đang ngoài phạm vi ${nearestName}${distanceText}. GPS: ±${Math.round(pos.coords.accuracy)}m`);
        }
      },
      (err) => {
        console.error('Geolocation error:', err);
        setError('Không thể lấy vị trí GPS. Vui lòng bật GPS và cho phép truy cập.');
        setLoading(false);
      },
      GEOLOCATION_OPTIONS
    );
  }, [sites]);

  useEffect(() => {
    updateLocation();
  }, [updateLocation]);

  const handleAction = (type: 'check-in' | 'check-out') => {
    if (!selectedSite) {
      setError('Bạn phải ở trong phạm vi công trường để chấm công.');
      return;
    }
    setAttendanceType(type);
    setIsCameraOpen(true);
  };

  const submitAttendance = async (photoBase64: string) => {
    if (!auth.currentUser || !selectedSite || !location || !attendanceType) return;

    setLoading(true);
    setIsCameraOpen(false);

    try {
      const timestamp = await fetchServerTime();
      let photoUrl = photoBase64;

      // Nếu online, upload ảnh lên Storage và lấy URL
      if (!isOffline) {
        try {
          const storageRef = ref(storage, `attendance/${auth.currentUser.uid}/${timestamp}.jpg`);

          const uploadAndGetUrl = async () => {
            await uploadString(storageRef, photoBase64, 'data_url');
            return await getDownloadURL(storageRef);
          };

          // Timeout 15 giây cho upload
          const timeoutPromise = new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error('Upload timeout')), 15000)
          );

          photoUrl = await Promise.race([uploadAndGetUrl(), timeoutPromise]);
        } catch (err) {
          // Khi upload fail, dùng chuỗi rỗng thay vì base64 để tránh vượt giới hạn 1MB của Firestore
          console.error('Storage upload failed or timed out, photo will be missing:', err);
          photoUrl = '';
        }
      } else {
        // Offline: không lưu base64 vào Firestore (vượt 1MB), để trống và đồng bộ sau
        photoUrl = '';
      }

      const record: Partial<AttendanceRecord> = {
        userId: auth.currentUser.uid,
        userName: auth.currentUser.displayName || auth.currentUser.email || 'Kỹ sư',
        timestamp,
        type: attendanceType,
        location: {
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
          accuracy: location.coords.accuracy,
        },
        photoUrl,
        siteId: selectedSite.id,
        siteName: selectedSite.name,
        isSynced: !isOffline,
      };

      // Save to Firestore (Firestore handles offline persistence automatically if enabled)
      const docRef = await addDoc(collection(db, 'attendance'), {
        ...record,
        serverTimestamp: serverTimestamp(), // Firestore server timestamp
      });

      // Calculate late/early/working hours
      let lateMinutes = 0;
      let earlyMinutes = 0;
      let workingHours: { hours: number; minutes: number } | undefined;
      let firstCheckInTime: number | null = null;

      const getExpectedTimestamp = (timeStr: any, currentTs: number, defaultTime: string) => {
        const validTimeStr = typeof timeStr === 'string' && timeStr.includes(':') ? timeStr : defaultTime;
        const [hours, minutes] = validTimeStr.split(':').map(Number);
        const date = new Date(currentTs);
        date.setHours(hours, minutes, 0, 0);
        return date.getTime();
      };

      if (attendanceType === 'check-in') {
        const expectedIn = getExpectedTimestamp(selectedSite.checkInTime, timestamp, '07:30');
        const diffInMinutes = Math.floor((timestamp - expectedIn) / 60000);
        if (diffInMinutes > 0) lateMinutes = diffInMinutes;
      } else if (attendanceType === 'check-out') {
        const expectedOut = getExpectedTimestamp(selectedSite.checkOutTime, timestamp, '17:30');
        const diffOutMinutes = Math.floor((expectedOut - timestamp) / 60000);
        if (diffOutMinutes > 0) earlyMinutes = diffOutMinutes;

        // Calculate working hours
        try {
          const startOfDay = new Date(timestamp);
          startOfDay.setHours(0, 0, 0, 0);
          const endOfDay = new Date(timestamp);
          endOfDay.setHours(23, 59, 59, 999);

          const q = query(
            collection(db, 'attendance'),
            where('userId', '==', auth.currentUser.uid),
            where('timestamp', '>=', startOfDay.getTime()),
            where('timestamp', '<=', endOfDay.getTime())
          );
          const snap = await getDocs(q);
          const checkInRecords = snap.docs
            .map(d => d.data() as AttendanceRecord)
            .filter(r => r.type === 'check-in')
            .sort((a, b) => a.timestamp - b.timestamp);
          
          if (checkInRecords.length > 0) {
            const firstCheckIn = checkInRecords[0];
            firstCheckInTime = firstCheckIn.timestamp;
            const totalWorkingMs = timestamp - firstCheckIn.timestamp;
            // Dùng giá trị cấu hình từng công trường, fallback về 120 phút
            const lunchBreakMs = (selectedSite.lunchBreakMinutes ?? 120) * 60 * 1000;
            const actualWorkingMs = Math.max(0, totalWorkingMs - lunchBreakMs);
            workingHours = {
              hours: Math.floor(actualWorkingMs / 3600000),
              minutes: Math.floor((actualWorkingMs % 3600000) / 60000)
            };
          }
        } catch (err) {
          console.error('Error calculating working hours:', err);
        }
      }

      // Sync to Lark Base
      if (!isOffline) {
        const startOfDay = new Date(timestamp);
        startOfDay.setHours(0, 0, 0, 0);
        const dateId = `${auth.currentUser.uid}_${startOfDay.getTime()}`;

        const syncData: any = {
          "ID": dateId,
          "Nhân viên": auth.currentUser.displayName || auth.currentUser.email || 'Kỹ sư',
          "Người quản lý": userProfile?.managerName || '',
          "Email người quản lý": userProfile?.managerEmail || '',
          "Thời gian": timestamp,
          "Loại": attendanceType === 'check-in' ? 'VÀO' : 'RA',
          "Công trường": selectedSite.name,
          "Vĩ độ": location.coords.latitude,
          "Kinh độ": location.coords.longitude,
        };

        if (attendanceType === 'check-in') {
          syncData["Giờ vào"] = timestamp;
          syncData["Ảnh vào"] = photoUrl; // Optional: if they have separate photo columns
          syncData["Ảnh"] = photoUrl;
        } else {
          if (firstCheckInTime) {
            syncData["Giờ vào"] = firstCheckInTime;
          }
          syncData["Giờ ra"] = timestamp;
          syncData["Ảnh ra"] = photoUrl; // Optional: if they have separate photo columns
          syncData["Ảnh"] = photoUrl;
        }

        await syncToLark('attendance', syncData);
      }

      setPopup({
        type: attendanceType,
        status: 'success',
        message: `Chấm công ${attendanceType === 'check-in' ? 'VÀO' : 'RA'} thành công!`,
        lateMinutes: lateMinutes > 0 ? lateMinutes : undefined,
        earlyMinutes: earlyMinutes > 0 ? earlyMinutes : undefined,
        workingHours,
        lunchBreakMinutes: selectedSite.lunchBreakMinutes ?? 120,
      });
      setAttendanceType(null);
    } catch (err) {
      console.error('Attendance submission failed:', err);
      // If it's a timeout, it might still succeed in the background when online
      if (err instanceof Error && err.message === 'Firestore write timeout') {
        setPopup({
          type: attendanceType as any,
          status: 'success',
          message: 'Mạng yếu, dữ liệu sẽ được đồng bộ khi có mạng. Chấm công đã được lưu tạm!'
        });
        setAttendanceType(null);
      } else {
        setError(`Lỗi khi gửi dữ liệu: ${err instanceof Error ? err.message : 'Vui lòng thử lại.'}`);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-md mx-auto p-4 space-y-6">
      {/* Status Card */}
      <div className={cn(
        "p-6 rounded-3xl shadow-xl transition-all duration-500",
        selectedSite ? "bg-green-50 border-2 border-green-200" : "bg-red-50 border-2 border-red-200"
      )}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className={cn(
              "p-3 rounded-2xl",
              selectedSite ? "bg-green-500 text-white" : "bg-red-500 text-white"
            )}>
              {selectedSite ? <CheckCircle size={24} /> : <AlertCircle size={24} />}
            </div>
            <div>
              <h2 className="font-bold text-xl text-gray-900">
                {selectedSite ? "Sẵn sàng" : "Ngoài phạm vi"}
              </h2>
              <p className="text-sm text-gray-600">
                {isOffline ? "Chế độ Offline" : "Đã kết nối Server"}
              </p>
            </div>
          </div>
          <button 
            onClick={updateLocation}
            disabled={loading}
            className="p-3 bg-white rounded-2xl shadow-sm hover:shadow-md active:scale-95 transition-all text-gray-600"
          >
            <RefreshCw size={20} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        {selectedSite ? (
          <div className="space-y-3">
            <div className="flex items-center gap-4">
              {selectedSite.imageUrl && (
                <div className="w-16 h-16 rounded-2xl overflow-hidden shrink-0 border-2 border-green-200 shadow-sm">
                  <img src={selectedSite.imageUrl} alt={selectedSite.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                </div>
              )}
              <div>
                <p className="text-gray-500 text-sm uppercase font-bold tracking-wider">Công trường hiện tại</p>
                <p className="text-2xl font-black text-green-700 leading-tight">{selectedSite.name}</p>
              </div>
            </div>
            <p className="text-sm text-green-800 font-medium mt-2 flex items-center gap-1">
              <Clock size={16} />
              Giờ làm việc: {selectedSite.checkInTime || '07:30'} - {selectedSite.checkOutTime || '17:30'}
            </p>
          </div>
        ) : (
          <p className="text-red-600 font-medium">
            {error || "Vui lòng di chuyển vào phạm vi công trường để chấm công."}
          </p>
        )}
        
        {selectedSite && error && (
          <p className="text-red-600 font-medium mt-4 p-3 bg-red-100 rounded-xl">
            {error}
          </p>
        )}
      </div>

      {/* Cảnh báo khi không xác minh được giờ server */}
      {usingClientTime && (
        <div className="flex items-start gap-3 p-4 bg-yellow-50 border border-yellow-200 rounded-2xl">
          <AlertCircle size={18} className="text-yellow-600 shrink-0 mt-0.5" />
          <p className="text-sm text-yellow-800 font-medium">
            Không kết nối được server thời gian — giờ chấm công sử dụng đồng hồ thiết bị.
          </p>
        </div>
      )}

      {/* Action Buttons */}
      <div className="grid grid-cols-1 gap-4">
        <button
          onClick={() => handleAction('check-in')}
          disabled={loading || !selectedSite}
          className={cn(
            "h-32 rounded-3xl flex flex-col items-center justify-center gap-2 transition-all active:scale-95 shadow-lg",
            selectedSite 
              ? "bg-blue-600 text-white hover:bg-blue-700" 
              : "bg-gray-200 text-gray-400 cursor-not-allowed"
          )}
        >
          <LogIn size={40} strokeWidth={2.5} />
          <span className="text-2xl font-black uppercase tracking-tighter">Check-in</span>
        </button>

        <button
          onClick={() => handleAction('check-out')}
          disabled={loading || !selectedSite}
          className={cn(
            "h-32 rounded-3xl flex flex-col items-center justify-center gap-2 transition-all active:scale-95 shadow-lg",
            selectedSite 
              ? "bg-orange-600 text-white hover:bg-orange-700" 
              : "bg-gray-200 text-gray-400 cursor-not-allowed"
          )}
        >
          <LogOut size={40} strokeWidth={2.5} />
          <span className="text-2xl font-black uppercase tracking-tighter">Check-out</span>
        </button>
      </div>

      {/* Info Footer */}
      <div className="text-center space-y-2">
        <div className="flex items-center justify-center gap-2 text-gray-500 font-mono text-sm">
          <MapPin size={14} />
          <span>
            {location ? `${location.coords.latitude.toFixed(4)}, ${location.coords.longitude.toFixed(4)}` : "Đang lấy vị trí..."}
          </span>
        </div>
        <p className="text-xs text-gray-400 uppercase font-bold tracking-widest">
          Độ chính xác: {location ? `${location.coords.accuracy.toFixed(1)}m` : "--"}
        </p>
      </div>

      {isCameraOpen && (
        <CameraComponent 
          onCapture={submitAttendance} 
          onClose={() => setIsCameraOpen(false)} 
        />
      )}

      {loading && !isCameraOpen && (
        <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-40">
          <div className="bg-white p-8 rounded-3xl shadow-2xl flex flex-col items-center gap-4">
            <Loader2 size={48} className="animate-spin text-blue-600" />
            <p className="font-bold text-gray-900">Đang xử lý...</p>
          </div>
        </div>
      )}

      {/* Success/Warning Popup */}
      {popup && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden animate-in fade-in zoom-in duration-300">
            <div className={cn(
              "p-6 text-center text-white",
              popup.status === 'success' ? "bg-green-500" : "bg-red-500"
            )}>
              {popup.status === 'success' ? (
                <CheckCircle size={64} className="mx-auto mb-4" />
              ) : (
                <AlertCircle size={64} className="mx-auto mb-4" />
              )}
              <h3 className="text-2xl font-black tracking-tight">{popup.message}</h3>
            </div>
            
            <div className="p-6 space-y-4 bg-gray-50">
              {popup.lateMinutes !== undefined && (
                <div className="flex items-start gap-3 p-4 bg-orange-100 text-orange-800 rounded-2xl">
                  <Clock className="shrink-0 mt-0.5" size={20} />
                  <div>
                    <p className="font-bold">Đi trễ</p>
                    <p className="text-sm">Bạn đã check-in trễ {popup.lateMinutes} phút so với quy định.</p>
                  </div>
                </div>
              )}
              
              {popup.earlyMinutes !== undefined && (
                <div className="flex items-start gap-3 p-4 bg-orange-100 text-orange-800 rounded-2xl">
                  <Clock className="shrink-0 mt-0.5" size={20} />
                  <div>
                    <p className="font-bold">Về sớm</p>
                    <p className="text-sm">Bạn đã check-out sớm {popup.earlyMinutes} phút so với quy định.</p>
                  </div>
                </div>
              )}

              {popup.workingHours && (
                <div className="flex items-start gap-3 p-4 bg-blue-100 text-blue-800 rounded-2xl">
                  <Clock className="shrink-0 mt-0.5" size={20} />
                  <div>
                    <p className="font-bold">Tổng thời gian làm việc</p>
                    <p className="text-sm">
                      {popup.workingHours.hours} giờ {popup.workingHours.minutes} phút
                    </p>
                    <p className="text-xs opacity-80 mt-1">(Đã trừ {popup.lunchBreakMinutes ?? 120} phút nghỉ trưa)</p>
                  </div>
                </div>
              )}

              <button
                onClick={() => setPopup(null)}
                className="w-full py-4 bg-gray-900 text-white rounded-2xl font-bold text-lg hover:bg-gray-800 active:scale-95 transition-all"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
