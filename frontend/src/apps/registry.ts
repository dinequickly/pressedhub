// In-tree App registry.
//
// Each App is a self-contained feature module that wraps one or more Claude
// Managed Agents. The agents do the work; the App provides the UI, the
// data-source plumbing, and whatever app-specific state. Apps share hub
// infra: auth, agent runtime, KB, vault connections, UI primitives.
//
// Adding an App:
//   1. Create src/apps/<slug>/ with a routes.tsx exporting a `Routes` component.
//   2. Optionally declare which agent names the app expects in `agents`.
//      The framework resolves them via useAppAgents() so the App can launch
//      sessions without hard-coding agent IDs.
//   3. Register the manifest in APPS below.

import type { ComponentType } from "react";
import type { IconType } from "react-icons";
import { LuImage } from "react-icons/lu";
import { ImageCreatorRoutes } from "./image-creator/routes";

export type AppManifest = {
  /** URL-safe slug. The App is mounted at /apps/<slug>. */
  slug: string;
  /** Display name on the launcher tile + nested header. */
  name: string;
  /** One-liner for the launcher tile. */
  tagline: string;
  /** Longer description shown on the launcher card. */
  description: string;
  /** react-icons component for the tile. */
  icon: IconType;
  /** Tailwind color name (matches existing `bg-${tint}-50` patterns). */
  tint: string;
  /**
   * Names of Managed Agents this App expects. The launcher and AppHost use
   * these to surface a "setup needed" state if any are missing. Apps resolve
   * the live agent rows via useAppAgents(manifest).
   */
  agents: string[];
  /** Routes for this App — rendered under /apps/<slug>/*. */
  Routes: ComponentType;
};

export const APPS: AppManifest[] = [
  {
    slug: "image-creator",
    name: "Image Creator",
    tagline: "Vibe-board AI image studio for marketing",
    description:
      "Per-user vibe boards: drop prompts, references, and notes onto a canvas, and the Director agent generates and iterates imagery alongside you.",
    icon: LuImage,
    tint: "fuchsia",
    agents: ["Image Studio Director"],
    Routes: ImageCreatorRoutes,
  },
];

export function findApp(slug: string): AppManifest | undefined {
  return APPS.find((a) => a.slug === slug);
}
