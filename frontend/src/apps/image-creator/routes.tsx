import { Route, Routes } from "react-router-dom";
import { BoardsListPage } from "./pages/BoardsList";
import { BoardPage } from "./pages/Board";

export function ImageCreatorRoutes() {
  return (
    <Routes>
      <Route path="/" element={<BoardsListPage />} />
      <Route path="/boards/:boardId" element={<BoardPage />} />
    </Routes>
  );
}
