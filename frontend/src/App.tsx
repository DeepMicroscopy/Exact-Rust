import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { PreferencesPage } from "./pages/PreferencesPage";
import { useAuth } from "./auth/AuthContext";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { Index } from "./pages/Index";
import { ImageSetPage } from "./pages/ImageSetPage";
import { JobsPage } from "./pages/JobsPage";
import { AdminPage } from "./pages/AdminPage";
import { InvitePage } from "./pages/InvitePage";
import { MprPage } from "./pages/MprPage";
import { ViewerPage } from "./pages/ViewerPage";
import { GlobalShortcuts } from "./components/GlobalShortcuts";
import { WelcomeGate } from "./components/WelcomeDialog";

export function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="splash">Loading…</div>;
  if (!user) {
    return (
      <Routes>
        <Route path="invite/:token" element={<InvitePage />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  return (
    <>
    <WelcomeGate />
    <GlobalShortcuts />
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Index />} />
        <Route path="sets/:setId" element={<ImageSetPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="preferences" element={<PreferencesPage />} />
        <Route path="invite/:token" element={<InvitePage />} />
      </Route>
      {/* the viewer is full-bleed and has its own chrome */}
      <Route path="images/:imageId" element={<ViewerPage />} />
      <Route path="images/:imageId/planes" element={<MprPage />} />
      <Route path="annotations/:imageId" element={<OldViewerLink />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}

/** Links of the old EXACT (`/annotations/<image>/?frame=..&xmin=..&ymin=..&xmax=..&ymax=..`) open the viewer on the same view. */
function OldViewerLink() {
  const { imageId } = useParams();
  const { search } = useLocation();
  return <Navigate to={`/images/${imageId}${search}`} replace />;
}
