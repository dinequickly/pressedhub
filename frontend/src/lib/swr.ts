// Tiny SWR wrappers so pages don't repeat the fetcher wiring.

import useSWR, { mutate, type SWRConfiguration } from "swr";
import { api } from "./api";

export function useApi<T>(path: string | null, opts?: SWRConfiguration<T>) {
  return useSWR<T>(path, (key: string) => api.get<T>(key), opts);
}

export function refresh(path: string) {
  return mutate(path);
}
