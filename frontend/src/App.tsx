import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { Index } from "./pages/Index";
import { ImageSetPage } from "./pages/ImageSetPage";
import { ViewerPage } from "./pages/ViewerPage";

export function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="splash">Loading…</div>;
  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Index />} />
        <Route path="sets/:setId" element={<ImageSetPage />} />
      </Route>
      {/* the viewer is full-bleed and has its own chrome */}
      <Route path="images/:imageId" element={<ViewerPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
