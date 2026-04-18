import React, { useState } from 'react';
import { UserProfile, Site } from '../types';
import { Check, AlertTriangle, Edit2, Save, X, Trash2 } from 'lucide-react';
import { cn } from '../lib/utils';

interface UserTableRowProps {
  user: UserProfile;
  sites: Site[];
  isAdmin: boolean;
  handleToggleVerification: (userId: string, currentStatus: boolean) => void;
  handleRoleChange: (userId: string, newRole: string) => void;
  handleManagerUpdate: (userId: string, managerName: string, managerEmail: string) => void;
  handleSiteRoleChange: (userId: string, siteId: string, newRole: string, currentAssignedSiteIds?: string[], currentSiteRoles?: Record<string, 'worker' | 'view_only'>) => void;
  handleBatchAssign: (userId: string, action: 'all_worker' | 'none') => void;
  handleUpdateUserInfo: (userId: string, displayName: string, email: string, employeeCode: string, fullName?: string) => void;
  handleDeleteUser: (userId: string, userName: string) => void;
}

export const UserTableRow: React.FC<UserTableRowProps> = ({
  user,
  sites,
  isAdmin,
  handleToggleVerification,
  handleRoleChange,
  handleManagerUpdate,
  handleSiteRoleChange,
  handleBatchAssign,
  handleUpdateUserInfo,
  handleDeleteUser
}) => {
  const [isEditingManager, setIsEditingManager] = useState(false);
  const [managerName, setManagerName] = useState(user.managerName || '');
  const [managerEmail, setManagerEmail] = useState(user.managerEmail || '');

  const [isEditingInfo, setIsEditingInfo] = useState(false);
  const [editName, setEditName] = useState(user.displayName || '');
  const [editFullName, setEditFullName] = useState(user.fullName || '');
  const [editEmail, setEditEmail] = useState(user.email || '');
  const [editEmployeeCode, setEditEmployeeCode] = useState(user.employeeCode || '');

  const onSaveManager = () => {
    handleManagerUpdate(user.uid, managerName, managerEmail);
    setIsEditingManager(false);
  };

  const onSaveInfo = () => {
    if (!editName.trim() || !editEmail.trim()) return;
    handleUpdateUserInfo(user.uid, editName.trim(), editEmail.trim(), editEmployeeCode.trim(), editFullName.trim());
    setIsEditingInfo(false);
  };

  const onCancelEditInfo = () => {
    setIsEditingInfo(false);
    setEditName(user.displayName || '');
    setEditFullName(user.fullName || '');
    setEditEmail(user.email || '');
    setEditEmployeeCode(user.employeeCode || '');
  };

  return (
    <tr className="hover:bg-gray-50/50 transition-colors">
      <td className="p-4 align-top">
        {isEditingInfo ? (
          <div className="flex flex-col gap-2 min-w-[220px]">
            <input
              type="text"
              placeholder="Mã nhân viên"
              value={editEmployeeCode}
              onChange={(e) => setEditEmployeeCode(e.target.value)}
              className="px-2 py-1 text-xs border rounded focus:ring-1 focus:ring-blue-500"
            />
            <input
              type="text"
              placeholder="Họ và tên thật"
              value={editFullName}
              onChange={(e) => setEditFullName(e.target.value)}
              className="px-2 py-1 text-xs border rounded focus:ring-1 focus:ring-blue-500"
            />
            <input
              type="text"
              placeholder="Tên Google (hiển thị)"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="px-2 py-1 text-xs border rounded focus:ring-1 focus:ring-blue-500"
            />
            <input
              type="email"
              placeholder="Email"
              value={editEmail}
              onChange={(e) => setEditEmail(e.target.value)}
              className="px-2 py-1 text-xs border rounded focus:ring-1 focus:ring-blue-500"
            />
            <div className="flex gap-2">
              <button
                onClick={onSaveInfo}
                className="flex items-center gap-1 text-[10px] font-bold text-green-600 bg-green-50 px-2 py-1 rounded"
              >
                <Save size={12} /> Lưu
              </button>
              <button
                onClick={onCancelEditInfo}
                className="flex items-center gap-1 text-[10px] font-bold text-gray-500 bg-gray-100 px-2 py-1 rounded"
              >
                <X size={12} /> Hủy
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between group min-w-[150px]">
            <div className="flex flex-col">
              {user.employeeCode && (
                <span className="text-[10px] font-bold text-blue-500 uppercase tracking-widest">{user.employeeCode}</span>
              )}
              {/* Ưu tiên hiển thị fullName (họ tên thật), fallback về displayName */}
              <span className="font-bold text-gray-900">{user.fullName || user.displayName || 'Chưa cập nhật tên'}</span>
              {user.fullName && user.displayName && user.fullName !== user.displayName && (
                <span className="text-[10px] text-gray-400 italic">{user.displayName}</span>
              )}
              <span className="text-xs text-gray-500">{user.email}</span>
            </div>
            {isAdmin && (
              <button
                onClick={() => setIsEditingInfo(true)}
                className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-blue-600 transition-opacity"
                title="Sửa thông tin"
              >
                <Edit2 size={14} />
              </button>
            )}
          </div>
        )}
      </td>

      <td className="p-4 align-top">
        {isEditingManager ? (
          <div className="flex flex-col gap-2 min-w-[200px]">
            <input
              type="text"
              placeholder="Tên người quản lý"
              value={managerName}
              onChange={(e) => setManagerName(e.target.value)}
              className="px-2 py-1 text-xs border rounded focus:ring-1 focus:ring-blue-500"
            />
            <input
              type="email"
              placeholder="Email người quản lý"
              value={managerEmail}
              onChange={(e) => setManagerEmail(e.target.value)}
              className="px-2 py-1 text-xs border rounded focus:ring-1 focus:ring-blue-500"
            />
            <div className="flex gap-2">
              <button onClick={onSaveManager} className="flex items-center gap-1 text-[10px] font-bold text-green-600 bg-green-50 px-2 py-1 rounded">
                <Save size={12} /> Lưu
              </button>
              <button onClick={() => {
                setIsEditingManager(false);
                setManagerName(user.managerName || '');
                setManagerEmail(user.managerEmail || '');
              }} className="flex items-center gap-1 text-[10px] font-bold text-gray-500 bg-gray-100 px-2 py-1 rounded">
                <X size={12} /> Hủy
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between group min-w-[150px]">
            <div className="flex flex-col">
              <span className="text-sm font-medium text-gray-700">{user.managerName || '-'}</span>
              <span className="text-xs text-gray-500">{user.managerEmail || '-'}</span>
            </div>
            {isAdmin && (
              <button
                onClick={() => setIsEditingManager(true)}
                className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-blue-600 transition-opacity"
              >
                <Edit2 size={14} />
              </button>
            )}
          </div>
        )}
      </td>

      <td className="p-4 align-top">
        <select
          value={user.role}
          onChange={(e) => handleRoleChange(user.uid, e.target.value)}
          disabled={!isAdmin}
          className={cn(
            "px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-widest border-none focus:ring-2 focus:ring-blue-500",
            isAdmin ? "cursor-pointer" : "cursor-default opacity-80",
            user.role === 'admin' ? "bg-purple-100 text-purple-700" :
            user.role === 'manager' ? "bg-indigo-100 text-indigo-700" :
            user.role === 'engineer' ? "bg-blue-100 text-blue-700" :
            "bg-gray-100 text-gray-600"
          )}
        >
          <option value="worker">WORKER</option>
          <option value="engineer">ENGINEER</option>
          <option value="manager">MANAGER</option>
          <option value="admin">ADMIN</option>
        </select>
      </td>

      <td className="p-4 align-top">
        <div className="flex flex-col items-start gap-2">
          {user.verified ? (
            <span className="flex items-center gap-0.5 px-1.5 py-0.5 bg-green-100 text-green-700 rounded-full text-[9px] font-bold uppercase tracking-wider">
              <Check size={8} /> Đã xác thực
            </span>
          ) : (
            <span className="flex items-center gap-0.5 px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded-full text-[9px] font-bold uppercase tracking-wider">
              <AlertTriangle size={8} /> Chờ xác thực
            </span>
          )}
          <button
            onClick={() => handleToggleVerification(user.uid, !!user.verified)}
            disabled={!isAdmin}
            className={cn(
              "px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-widest transition-all border",
              !isAdmin && "opacity-50 cursor-not-allowed",
              user.verified
                ? "bg-white border-red-200 text-red-600 hover:bg-red-50"
                : "bg-green-600 border-green-600 text-white hover:bg-green-700"
            )}
          >
            {user.verified ? "Hủy xác thực" : "Xác thực"}
          </button>
        </div>
      </td>

      <td className="p-4 align-top min-w-[250px]">
        <div className="flex justify-between items-center mb-2">
          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Phân công</p>
          {sites.length > 0 && isAdmin && (
            <div className="flex gap-2">
              <button onClick={() => handleBatchAssign(user.uid, 'all_worker')} className="text-[10px] font-bold text-blue-600 uppercase hover:underline">Tất cả</button>
              <button onClick={() => handleBatchAssign(user.uid, 'none')} className="text-[10px] font-bold text-red-600 uppercase hover:underline">Bỏ tất cả</button>
            </div>
          )}
        </div>
        {sites.length === 0 ? (
          <p className="text-xs text-gray-400 italic">Chưa có công trường</p>
        ) : (
          <div className="space-y-1 max-h-32 overflow-y-auto pr-1">
            {sites.map(site => {
              const isAssigned = (user.assignedSiteIds || []).includes(site.id);
              const currentRole = user.siteRoles?.[site.id] || (isAssigned ? 'worker' : 'none');

              return (
                <div
                  key={site.id}
                  className={cn(
                    "w-full flex items-center justify-between p-1.5 rounded text-xs transition-all border",
                    currentRole === 'worker' ? "bg-blue-50 border-blue-200" :
                    currentRole === 'view_only' ? "bg-orange-50 border-orange-200" :
                    "bg-white border-gray-100 hover:bg-gray-50"
                  )}
                >
                  <span className={cn(
                    "font-medium truncate max-w-[120px]",
                    currentRole === 'worker' ? "text-blue-700" :
                    currentRole === 'view_only' ? "text-orange-700" :
                    "text-gray-600"
                  )} title={site.name}>{site.name}</span>

                  <select
                    value={currentRole}
                    onChange={(e) => handleSiteRoleChange(user.uid, site.id, e.target.value, user.assignedSiteIds, user.siteRoles)}
                    disabled={!isAdmin}
                    className={cn(
                      "bg-white border rounded px-1 py-0.5 text-[10px] font-bold focus:outline-none focus:ring-1 focus:ring-blue-500",
                      isAdmin ? "cursor-pointer" : "cursor-default opacity-80",
                      currentRole === 'worker' ? "border-blue-200 text-blue-700" :
                      currentRole === 'view_only' ? "border-orange-200 text-orange-700" :
                      "border-gray-200 text-gray-500"
                    )}
                  >
                    <option value="none">Không</option>
                    <option value="worker">Chấm công</option>
                    <option value="view_only">Chỉ xem</option>
                  </select>
                </div>
              );
            })}
          </div>
        )}
      </td>

      {isAdmin && (
        <td className="p-4 align-top">
          <button
            onClick={() => handleDeleteUser(user.uid, user.displayName || user.email || user.uid)}
            className="p-2 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50 transition-all"
            title="Xóa nhân viên"
          >
            <Trash2 size={16} />
          </button>
        </td>
      )}
    </tr>
  );
};
