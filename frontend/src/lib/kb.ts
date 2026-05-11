import { api, type KbFile } from "./api";

export async function uploadKbFile(file: File, folderId?: string | null): Promise<KbFile> {
  const signed = await api.post<{
    file: KbFile;
    signed_url: string;
    token: string;
    path: string;
  }>("/kb/files/upload-url", {
    ...(folderId ? { folder_id: folderId } : {}),
    name: file.name,
    mime: file.type || "application/octet-stream",
    size_bytes: file.size,
  });
  const put = await fetch(signed.signed_url, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!put.ok) throw new Error(`Upload failed: ${put.status}`);

  await api.post(`/kb/files/${signed.file.id}/extract`);
  await api.post(`/kb/files/${signed.file.id}/chunk`);
  await api.post(`/kb/files/${signed.file.id}/embed`);
  try {
    await api.post(`/kb/files/${signed.file.id}/sync-to-anthropic`);
  } catch (err) {
    console.warn("[kb] sync-to-anthropic failed:", err);
  }

  return signed.file;
}
