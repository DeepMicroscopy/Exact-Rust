import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { Index } from "./pages/Index";
import { ImageSetPage } from "./pages/ImageSetPage";
import { AdminPage } from "./pages/AdminPage";
import { InvitePage } from "./pages/InvitePage";
import { ViewerPage } from "./pages/ViewerPage";

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
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Index />} />
        <Route path="sets/:setId" element={<ImageSetPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="invite/:token" element={<InvitePage />} />
      </Route>
      {/* the viewer is full-bleed and has its own chrome */}
      <Route path="images/:imageId" element={<ViewerPage />} />
      <Route path="annotations/:imageId" element={<OldViewerLink />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** Links of the old EXACT (`/annotations/<image>/?frame=..&xmin=..&ymin=..&xmax=..&ymax=..`) open the viewer on the same view. */
function OldViewerLink() {
  const { imageId } = useParams();
  const { search } = useLocation();
  return <Navigate to={`/images/${imageId}${search}`} replace />;
}
