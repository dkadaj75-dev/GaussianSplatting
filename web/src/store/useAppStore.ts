import { create } from 'zustand';
import type { Job, Project } from '../types';

/**
 * Client-side app state.
 *
 * Server data lives in TanStack Query; this store holds the things the server
 * does not own: current selection, locally-known job progress pushed over the
 * WebSocket (WP 0.4), and the viewer's current splat source.
 */
export interface AppState {
  projects: Project[];
  jobsByProjectId: Record<string, Job>;
  selectedProjectId: string | null;
  /** Last splat URL opened in the viewer; survives route changes. */
  viewerSrc: string | null;

  setProjects: (projects: Project[]) => void;
  upsertProject: (project: Project) => void;
  removeProject: (id: string) => void;
  selectProject: (id: string | null) => void;
  upsertJob: (job: Job) => void;
  setViewerSrc: (src: string | null) => void;
  reset: () => void;
}

const initialState = {
  projects: [] as Project[],
  jobsByProjectId: {} as Record<string, Job>,
  selectedProjectId: null as string | null,
  viewerSrc: null as string | null,
};

export const useAppStore = create<AppState>()((set) => ({
  ...initialState,

  setProjects: (projects) => set({ projects }),

  upsertProject: (project) =>
    set((state) => {
      const index = state.projects.findIndex((p) => p.id === project.id);
      if (index === -1) return { projects: [project, ...state.projects] };
      const projects = state.projects.slice();
      projects[index] = { ...projects[index], ...project };
      return { projects };
    }),

  removeProject: (id) =>
    set((state) => ({
      projects: state.projects.filter((p) => p.id !== id),
      selectedProjectId: state.selectedProjectId === id ? null : state.selectedProjectId,
    })),

  selectProject: (id) => set({ selectedProjectId: id }),

  upsertJob: (job) =>
    set((state) => ({
      jobsByProjectId: { ...state.jobsByProjectId, [job.projectId]: job },
    })),

  setViewerSrc: (src) => set({ viewerSrc: src }),

  reset: () => set({ ...initialState }),
}));

/** Selector helpers keep components from re-rendering on unrelated changes. */
export const selectProjects = (state: AppState) => state.projects;
export const selectViewerSrc = (state: AppState) => state.viewerSrc;
