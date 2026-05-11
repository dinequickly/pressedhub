// Maps a profile id to one of four juice product shots used as avatar art.
// Hash is deterministic so the same user always lands on the same juice.

const JUICES = [
  "/pfps/greens.png",
  "/pfps/citrus.png",
  "/pfps/celery.png",
  "/pfps/dragonfruit.png",
];

export function juicePfp(seed: string | null | undefined): string {
  const s = seed ?? "";
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return JUICES[Math.abs(h) % JUICES.length];
}
