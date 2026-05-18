import { api, type KbFile } from "./api";
import { supabase } from "./supabase";

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

  const { error: uploadErr } = await supabase.storage
    .from("kb")
    .uploadToSignedUrl(signed.path, signed.token, file, {
      contentType: file.type || "application/octet-stream",
    });
  if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`);

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
