import React, { useState, useEffect, useMemo } from 'react';
import { db, auth } from '../firebase';
import { collection, query, where, getDocs, orderBy } from 'firebase/firestore';
import { AttendanceRecord, Site } from '../types';
import { Calendar, Clock, AlertCircle, TrendingUp, Coffee, Moon, ChevronLeft, ChevronRight, BarChart3 } from 'lucide-react';
import { cn } from '../lib/utils';
import { getCachedSites } from '../lib/sitesCache';

export const UserDashboard: React.FC = () => {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth());
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());

  // Load sites 1 lần khi mount — dùng module-level cache, không fetch lại khi đổi tháng
  useEffect(() => {
    getCachedSites().then(setSites).catch(err => console.error('Error loading sites:', err));
  }, []);

  // Load attendance khi đổi tháng — scoped theo user + khoảng thời gian cụ thể
  useEffect(() => {
    const fetchAttendance = async () => {
      if (!auth.currentUser) return;
      setLoading(true);

      try {
        const startOfMonth = new Date(selectedYear, selectedMonth, 1).getTime();
        const endOfMonth = new Date(selectedYear, selectedMonth + 1, 0, 23, 59, 59).getTime();

        const q = query(
          collection(db, 'attendance'),
          where('userId', '==', auth.currentUser.uid),
          where('timestamp', '>=', startOfMonth),
          where('timestamp', '<=', endOfMonth),
          orderBy('timestamp', 'asc')
        );

        const querySnapshot = await getDocs(q);
        const recordsData = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as AttendanceRecord[];
        setRecords(recordsData);
      } catch (error) {
        console.error('Error fetching attendance:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchAttendance();
  }, [selectedMonth, selectedYear]);

  const stats = useMemo(() => {
    if (records.length === 0) return {
      workingDays: 0,
      daysOff: 0,
      lateCount: 0,
      lateMinutes: 0,
      earlyCount: 0,
      earlyMinutes: 0,
      overtimeHours: 0,
      overtimeCount: 0
    };

    // Group records by day
    const days: Record<string, AttendanceRecord[]> = {};
    records.forEach(record => {
      const dateKey = new Date(record.timestamp).toLocaleDateString();
      if (!days[dateKey]) days[dateKey] = [];
      days[dateKey].push(record);
    });

    let workingDays = Object.keys(days).length;
    let lateCount = 0;
    let lateMinutes = 0;
    let earlyCount = 0;
    let earlyMinutes = 0;
    let overtimeHours = 0;
    let overtimeCount = 0;

    Object.values(days).forEach(dayRecords => {
      const checkIn = dayRecords.find(r => r.type === 'check-in');
      const checkOut = dayRecords.find(r => r.type === 'check-out');
      
      if (checkIn) {
        const site = sites.find(s => s.id === checkIn.siteId);
        if (site && typeof site.checkInTime === 'string' && site.checkInTime.includes(':')) {
          const [targetH, targetM] = site.checkInTime.split(':').map(Number);
          const actualTime = new Date(checkIn.timestamp);
          const targetTime = new Date(checkIn.timestamp);
          targetTime.setHours(targetH, targetM, 0, 0);

          if (actualTime.getTime() > targetTime.getTime()) {
            lateCount++;
            lateMinutes += Math.floor((actualTime.getTime() - targetTime.getTime()) / 60000);
          }
        }
      }

      if (checkOut) {
        const site = sites.find(s => s.id === checkOut.siteId);
        if (site && typeof site.checkOutTime === 'string' && site.checkOutTime.includes(':')) {
          const [targetH, targetM] = site.checkOutTime.split(':').map(Number);
          const actualTime = new Date(checkOut.timestamp);
          const targetTime = new Date(checkOut.timestamp);
          targetTime.setHours(targetH, targetM, 0, 0);

          // Early departure
          if (actualTime.getTime() < targetTime.getTime()) {
            earlyCount++;
            earlyMinutes += Math.floor((targetTime.getTime() - actualTime.getTime()) / 60000);
          }

          // Overtime (Time worked after check-out time)
          if (actualTime.getTime() > targetTime.getTime()) {
            const diff = (actualTime.getTime() - targetTime.getTime()) / 3600000;
            if (diff > 0.5) { // Only count if more than 30 mins
              overtimeCount++;
              overtimeHours += diff;
            }
          }
        }
      }
    });

    const daysInMonth = new Date(selectedYear, selectedMonth + 1, 0).getDate();
    // Simple calculation for days off: total days in month - working days (excluding Sundays)
    let totalSundays = 0;
    for (let i = 1; i <= daysInMonth; i++) {
      if (new Date(selectedYear, selectedMonth, i).getDay() === 0) totalSundays++;
    }
    const expectedWorkingDays = daysInMonth - totalSundays;
    const daysOff = Math.max(0, expectedWorkingDays - workingDays);

    return {
      workingDays,
      daysOff,
      lateCount,
      lateMinutes,
      earlyCount,
      earlyMinutes,
      overtimeHours: Math.round(overtimeHours * 10) / 10,
      overtimeCount
    };
  }, [records, sites, selectedMonth, selectedYear]);

  const changeMonth = (offset: number) => {
    let newMonth = selectedMonth + offset;
    let newYear = selectedYear;
    if (newMonth < 0) {
      newMonth = 11;
      newYear--;
    } else if (newMonth > 11) {
      newMonth = 0;
      newYear++;
    }
    setSelectedMonth(newMonth);
    setSelectedYear(newYear);
  };

  const monthNames = [
    "Tháng 1", "Tháng 2", "Tháng 3", "Tháng 4", "Tháng 5", "Tháng 6",
    "Tháng 7", "Tháng 8", "Tháng 9", "Tháng 10", "Tháng 11", "Tháng 12"
  ];

  if (loading) {
    return (
      <div className="p-8 text-center space-y-4">
        <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto"></div>
        <p className="text-gray-500 font-bold uppercase tracking-widest text-xs">Đang tính toán báo cáo...</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-6 pb-20">
      {/* Month Selector */}
      <div className="flex items-center justify-between bg-white p-4 rounded-3xl shadow-sm border border-gray-100">
        <button onClick={() => changeMonth(-1)} className="p-2 hover:bg-gray-100 rounded-xl transition-colors">
          <ChevronLeft size={24} className="text-gray-600" />
        </button>
        <div className="text-center">
          <h2 className="font-black text-gray-900 uppercase tracking-tighter text-xl">
            {monthNames[selectedMonth]}
          </h2>
          <p className="text-[10px] font-bold text-blue-600 uppercase tracking-widest">{selectedYear}</p>
        </div>
        <button onClick={() => changeMonth(1)} className="p-2 hover:bg-gray-100 rounded-xl transition-colors">
          <ChevronRight size={24} className="text-gray-600" />
        </button>
      </div>

      {/* Main Stats Grid */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white p-5 rounded-[32px] shadow-sm border border-gray-100 flex flex-col items-center text-center space-y-2">
          <div className="w-12 h-12 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600">
            <Calendar size={24} />
          </div>
          <div>
            <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Ngày công</p>
            <p className="text-3xl font-black text-gray-900 tracking-tighter">{stats.workingDays}</p>
          </div>
        </div>

        <div className="bg-white p-5 rounded-[32px] shadow-sm border border-gray-100 flex flex-col items-center text-center space-y-2">
          <div className="w-12 h-12 bg-orange-50 rounded-2xl flex items-center justify-center text-orange-600">
            <Coffee size={24} />
          </div>
          <div>
            <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Ngày nghỉ</p>
            <p className="text-3xl font-black text-gray-900 tracking-tighter">{stats.daysOff}</p>
          </div>
        </div>
      </div>

      {/* Detailed Stats Cards */}
      <div className="space-y-4">
        {/* Late Arrival */}
        <div className="bg-white p-6 rounded-[32px] shadow-sm border border-gray-100 space-y-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-red-50 rounded-2xl flex items-center justify-center text-red-600">
              <Clock size={24} />
            </div>
            <div>
              <h3 className="font-black text-gray-900 uppercase tracking-tighter">Đi muộn</h3>
              <p className="text-xs text-gray-500 font-medium">Thống kê vi phạm giờ giấc</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 pt-2">
            <div className="bg-gray-50 p-4 rounded-2xl">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Số lần</p>
              <p className="text-xl font-black text-red-600 tracking-tighter">{stats.lateCount} lần</p>
            </div>
            <div className="bg-gray-50 p-4 rounded-2xl">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Tổng giờ</p>
              <p className="text-xl font-black text-red-600 tracking-tighter">
                {Math.floor(stats.lateMinutes / 60)}h {stats.lateMinutes % 60}m
              </p>
            </div>
          </div>
        </div>

        {/* Early Departure */}
        <div className="bg-white p-6 rounded-[32px] shadow-sm border border-gray-100 space-y-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-amber-50 rounded-2xl flex items-center justify-center text-amber-600">
              <TrendingUp size={24} className="rotate-180" />
            </div>
            <div>
              <h3 className="font-black text-gray-900 uppercase tracking-tighter">Về sớm</h3>
              <p className="text-xs text-gray-500 font-medium">Thống kê rời vị trí sớm</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 pt-2">
            <div className="bg-gray-50 p-4 rounded-2xl">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Số lần</p>
              <p className="text-xl font-black text-amber-600 tracking-tighter">{stats.earlyCount} lần</p>
            </div>
            <div className="bg-gray-50 p-4 rounded-2xl">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Tổng giờ</p>
              <p className="text-xl font-black text-amber-600 tracking-tighter">
                {Math.floor(stats.earlyMinutes / 60)}h {stats.earlyMinutes % 60}m
              </p>
            </div>
          </div>
        </div>

        {/* Overtime */}
        <div className="bg-white p-6 rounded-[32px] shadow-sm border border-gray-100 space-y-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-purple-50 rounded-2xl flex items-center justify-center text-purple-600">
              <Moon size={24} />
            </div>
            <div>
              <h3 className="font-black text-gray-900 uppercase tracking-tighter">Tăng ca</h3>
              <p className="text-xs text-gray-500 font-medium">Làm thêm ngoài giờ quy định</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 pt-2">
            <div className="bg-gray-50 p-4 rounded-2xl">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Số buổi</p>
              <p className="text-xl font-black text-purple-600 tracking-tighter">{stats.overtimeCount} buổi</p>
            </div>
            <div className="bg-gray-50 p-4 rounded-2xl">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Tổng giờ</p>
              <p className="text-xl font-black text-purple-600 tracking-tighter">{stats.overtimeHours} giờ</p>
            </div>
          </div>
        </div>
      </div>

      {/* Info Banner */}
      <div className="bg-blue-600 p-6 rounded-[40px] shadow-xl text-white relative overflow-hidden">
        <div className="relative z-10">
          <div className="flex items-center gap-2 mb-2">
            <BarChart3 size={18} />
            <h4 className="font-bold uppercase tracking-widest text-xs">Phân tích hiệu suất</h4>
          </div>
          <p className="text-sm font-medium opacity-90 leading-relaxed">
            Dữ liệu được tổng hợp dựa trên các mốc thời gian quy định tại từng công trường.
          </p>
        </div>
        <div className="absolute -right-8 -bottom-8 w-32 h-32 bg-white opacity-10 rounded-full"></div>
      </div>
    </div>
  );
};
