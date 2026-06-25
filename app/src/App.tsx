import { Routes, Route, Navigate } from "react-router-dom";
import Landing from "@/surfaces/marketing/Landing";
import AdminApp from "@/surfaces/admin/AdminApp";
import MemberApp from "@/surfaces/member/MemberApp";
import VerifyPage from "@/surfaces/verify/VerifyPage";
import CheckinPage from "@/surfaces/verify/CheckinPage";
import SuperadminApp from "@/surfaces/superadmin/SuperadminApp";

export default function App() {
  return (
    <Routes>
      {/* public marketing landing — faithful port of stanbase.html */}
      <Route path="/" element={<Landing />} />

      {/* owner's standardized admin (identity chrome, not themable) */}
      <Route path="/admin/*" element={<AdminApp />} />

      {/* member front, themable per org */}
      <Route path="/m/:orgSlug/*" element={<MemberApp />} />

      {/* public member validation + door operator check-in */}
      <Route path="/verify/:memberId" element={<VerifyPage />} />
      <Route path="/checkin/*" element={<CheckinPage />} />

      {/* Stanbase staff */}
      <Route path="/superadmin/*" element={<SuperadminApp />} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
