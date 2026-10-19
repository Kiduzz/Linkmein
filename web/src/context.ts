import { createContext, useContext } from "react";
import type { AppConfig, Me } from "./api";

export interface AppState {
  me: Me;
  config: AppConfig;
  refreshMe: () => Promise<void>;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppContext");
  return ctx;
}
